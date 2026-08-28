//! 从官方 release tag 准备、校验并提升源码更新。
//!
//! `prepare_release` 只在 detached 临时 worktree 中合并和构建；主 worktree
//! 仅由 `promote_prepared` 在二次 CAS 校验通过后执行 fast-forward。

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use uuid::Uuid;

use super::error::AdminServiceError;

const MAX_CAPTURE_BYTES: usize = 64 * 1024;
const MAX_ERROR_OUTPUT_BYTES: usize = 8 * 1024;
const MAX_SIDECAR_BYTES: u64 = 1024 * 1024;
const DRAIN_TIMEOUT: Duration = Duration::from_secs(10);
const QUICK_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_FETCH_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const GIT_WORKTREE_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const GIT_MERGE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const NPM_INSTALL_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const NPM_BUILD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const CARGO_CHECK_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const CARGO_TEST_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const CARGO_BUILD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

const FETCHED_REF_PREFIX: &str = "refs/kiro-source-update/tags/";
const STAGED_REF_PREFIX: &str = "refs/kiro-source-update/staged/";
const TRUSTED_SOURCE_UPSTREAM: &str = "https://github.com/ZyphrZero/kiro.rs.git";

/// 串行化当前进程内的 prepare/promote/finalize，避免 binary 与 sidecar 交叉发布。
static SOURCE_UPDATE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(unix)]
unsafe extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}

/// 源码更新配置。`build_path` 会作为每个外部命令唯一显式设置的 `PATH`。
pub(super) struct SourceUpdateConfig {
    pub repo_path: PathBuf,
    pub branch: String,
    pub upstream_git_url: String,
    pub build_path: String,
}

/// 已完成合并、校验和 release 构建，等待提升的更新。
#[derive(Clone, Debug)]
pub(super) struct PreparedSourceUpdate {
    pub version: String,
    pub tag: String,
    pub base_head: String,
    pub merged_commit: String,
    pub staged_ref: String,
    pub reused: bool,
    pub output: String,
}

#[derive(Clone)]
struct ValidatedConfig {
    repo_path: PathBuf,
    canonical_repo: String,
    branch: String,
    upstream_git_url: String,
    build_path: String,
}

struct Preflight {
    head: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct SourceUpdateSidecar {
    version: String,
    tag: String,
    canonical_repo: String,
    branch: String,
    upstream_git_url: String,
    base_head: String,
    merged_commit: String,
    staged_ref: String,
    created_at: String,
}

struct CommandOutput {
    status: ExitStatus,
    stdout: CapturedStream,
    stderr: CapturedStream,
}

#[derive(Default)]
struct CapturedStream {
    bytes: Vec<u8>,
    truncated: bool,
}

/// 准备 release 源码更新，但绝不移动当前 checkout 分支。
pub(super) async fn prepare_release(
    config: &SourceUpdateConfig,
    version: &str,
    staged: &Path,
) -> Result<PreparedSourceUpdate, AdminServiceError> {
    let _update_guard = SOURCE_UPDATE_LOCK.lock().await;
    validate_staged_path(staged)?;
    let config = validate_config(config).await?;
    let staged = validate_staged_destination(&config, staged).await?;
    let version = normalize_version(version)?;
    let tag = format!("v{version}");
    validate_tag(&tag, &version)?;

    // preflight 必须发生在任何 fetch/ref/临时目录改动之前。
    let preflight = preflight(&config).await?;
    let sidecar_path = sidecar_path(&staged);
    let old_sidecar = read_sidecar_lenient(&sidecar_path).await?;

    if let Some(prepared) = try_reuse(
        &config,
        &version,
        &tag,
        &preflight.head,
        &staged,
        old_sidecar.as_ref(),
    )
    .await?
    {
        return Ok(prepared);
    }

    cleanup_previous(&config, &staged, &sidecar_path, old_sidecar.as_ref()).await?;

    let job_id = Uuid::new_v4().to_string();
    if !is_safe_ref_component(&job_id) {
        return Err(internal("生成了不安全的 source update job id"));
    }
    let fetched_ref = format!("{FETCHED_REF_PREFIX}{job_id}");
    let staged_ref = format!("{STAGED_REF_PREFIX}{job_id}");
    if !is_fetched_ref(&fetched_ref) || !is_staged_ref(&staged_ref) {
        return Err(internal("生成的 source update ref 不符合命名空间约束"));
    }

    let temp_root = std::env::temp_dir().join(format!("kiro-source-update-{job_id}"));
    let worktree = temp_root.join("worktree");
    let mut worktree_cleanup_needed = false;
    let mut created_staged_commit: Option<String> = None;

    let attempt = async {
        fetch_release_tag(&config, &tag, &fetched_ref).await?;
        tokio::fs::create_dir(&temp_root).await.map_err(|error| {
            internal(format!(
                "创建源码更新临时目录 {} 失败: {error}",
                temp_root.display()
            ))
        })?;
        worktree_cleanup_needed = true;
        add_detached_worktree(&config, &worktree, &preflight.head).await?;

        merge_fetched_ref(&config, &worktree, &fetched_ref).await?;
        let merged_commit = read_worktree_head(&config, &worktree).await?;
        create_staged_ref(&config, &staged_ref, &merged_commit).await?;
        created_staged_commit = Some(merged_commit.clone());

        build_and_stage(&config, &worktree, &staged, &job_id).await?;

        let metadata = SourceUpdateSidecar {
            version: version.clone(),
            tag: tag.clone(),
            canonical_repo: config.canonical_repo.clone(),
            branch: config.branch.clone(),
            upstream_git_url: config.upstream_git_url.clone(),
            base_head: preflight.head.clone(),
            merged_commit: merged_commit.clone(),
            staged_ref: staged_ref.clone(),
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        write_sidecar_atomic(&sidecar_path, &metadata, &job_id).await?;

        Ok(PreparedSourceUpdate {
            version: version.clone(),
            tag: tag.clone(),
            base_head: preflight.head.clone(),
            merged_commit,
            staged_ref: staged_ref.clone(),
            reused: false,
            output: format!(
                "已在 detached 临时 worktree 合并 {tag}，完成前端构建及 cargo check/test/release build"
            ),
        })
    }
    .await;

    let cleanup_errors = cleanup_job(
        &config,
        worktree_cleanup_needed.then_some(worktree.as_path()),
        &temp_root,
        &fetched_ref,
    )
    .await;

    match attempt {
        Ok(prepared) if cleanup_errors.is_empty() => Ok(prepared),
        Ok(_) => {
            let artifact_errors = cleanup_failed_prepare(
                &config,
                &staged,
                &sidecar_path,
                &staged_ref,
                created_staged_commit.as_deref(),
            )
            .await;
            let mut all_errors = cleanup_errors;
            all_errors.extend(artifact_errors);
            Err(internal(format!(
                "源码更新准备完成，但临时资源清理失败: {}",
                all_errors.join("; ")
            )))
        }
        Err(error) => {
            for cleanup_error in &cleanup_errors {
                tracing::warn!(error = %cleanup_error, "清理失败的 source update 临时资源时出错");
            }
            for cleanup_error in cleanup_failed_prepare(
                &config,
                &staged,
                &sidecar_path,
                &staged_ref,
                created_staged_commit.as_deref(),
            )
            .await
            {
                tracing::warn!(error = %cleanup_error, "清理失败的 source update 产物时出错");
            }
            Err(error)
        }
    }
}

/// 在主 worktree 上执行二次 CAS 后，将已准备提交 fast-forward 到目标分支。
pub(super) async fn promote_prepared(
    config: &SourceUpdateConfig,
    prepared: &PreparedSourceUpdate,
    staged: &Path,
) -> Result<(), AdminServiceError> {
    let _update_guard = SOURCE_UPDATE_LOCK.lock().await;
    validate_staged_path(staged)?;
    validate_prepared(prepared)?;
    let config = validate_config(config).await?;
    let staged = validate_staged_destination(&config, staged).await?;
    let current = preflight(&config).await?;

    if current.head != prepared.base_head {
        return Err(invalid(format!(
            "源码更新 CAS 失败：当前 HEAD {} 不等于准备时 HEAD {}",
            current.head, prepared.base_head
        )));
    }

    let sidecar_path = sidecar_path(&staged);
    let metadata = read_sidecar_lenient(&sidecar_path)
        .await?
        .ok_or_else(|| invalid("源码更新 metadata 不存在或无效，拒绝提升"))?;
    if !sidecar_matches_prepared(&metadata, &config, prepared) {
        return Err(invalid(
            "源码更新 metadata/config 与已准备更新不一致，拒绝提升",
        ));
    }
    if !is_nonempty_regular_file(&staged).await? {
        return Err(invalid("staged 源码更新二进制不存在、为空或不是普通文件"));
    }

    let resolved = resolve_ref(&config, &prepared.staged_ref)
        .await?
        .ok_or_else(|| invalid("staged ref 不存在，拒绝提升源码更新"))?;
    if resolved != prepared.merged_commit {
        return Err(invalid(format!(
            "源码更新 CAS 失败：staged ref 解引用为 {resolved}，预期 {}",
            prepared.merged_commit
        )));
    }

    let final_preflight = preflight(&config).await?;
    if final_preflight.head != prepared.base_head {
        return Err(invalid(format!(
            "源码更新 CAS 失败：提升前 HEAD {} 不等于准备时 HEAD {}",
            final_preflight.head, prepared.base_head
        )));
    }

    let output = run_command(
        &config,
        "git",
        vec![
            os("-C"),
            config.repo_path.as_os_str().to_owned(),
            os("merge"),
            os("--ff-only"),
            os("--"),
            OsString::from(&prepared.merged_commit),
        ],
        None,
        GIT_MERGE_TIMEOUT,
        "fast-forward 主源码分支",
    )
    .await?;
    if !output.status.success() {
        let failure = command_failure_message("fast-forward 主源码分支", &output);
        return match preflight(&config).await {
            Ok(after_failure) if after_failure.head != prepared.base_head => Err(invalid(format!(
                "源码更新 CAS 失败：fast-forward 期间 HEAD 从 {} 变为 {}",
                prepared.base_head, after_failure.head
            ))),
            Ok(_) => Err(internal(failure)),
            Err(error @ AdminServiceError::InvalidCredential(_)) => Err(error),
            Err(error) => Err(error),
        };
    }

    let promoted_head = read_repo_head(&config).await?;
    if promoted_head != prepared.merged_commit {
        return Err(invalid(format!(
            "源码更新提升后 HEAD 校验失败：实际 {promoted_head}，预期 {}",
            prepared.merged_commit
        )));
    }
    Ok(())
}

/// 成功安装 staged 二进制后，尽力清理 metadata、staged ref 和残留 staged 文件。
///
/// 此阶段的清理失败只记录日志，不把已成功的安装转成失败。
pub(super) async fn finalize_prepared(
    config: &SourceUpdateConfig,
    prepared: &PreparedSourceUpdate,
    staged: &Path,
) {
    let _update_guard = SOURCE_UPDATE_LOCK.lock().await;
    let config = match validate_config(config).await {
        Ok(config) => config,
        Err(error) => {
            tracing::warn!(error = %error, "finalize 校验 source update 配置失败");
            return;
        }
    };
    let staged = match validate_staged_destination(&config, staged).await {
        Ok(staged) => staged,
        Err(error) => {
            tracing::warn!(error = %error, "finalize 校验 staged 路径失败");
            if let Err(error) =
                delete_staged_ref_cas(&config, &prepared.staged_ref, &prepared.merged_commit).await
            {
                tracing::warn!(error = %error, "finalize 清理 source update staged ref 失败");
            }
            return;
        }
    };
    let sidecar_path = sidecar_path(&staged);
    let may_remove_files = match read_sidecar_lenient(&sidecar_path).await {
        Ok(Some(metadata)) => {
            let matches = sidecar_matches_prepared(&metadata, &config, prepared);
            if !matches {
                tracing::warn!("source update metadata 已变化，finalize 不删除并发任务的文件");
            }
            matches
        }
        Ok(None) => false,
        Err(error) => {
            tracing::warn!(error = %error, "finalize 读取 source update metadata 失败");
            false
        }
    };

    if let Err(error) =
        delete_staged_ref_cas(&config, &prepared.staged_ref, &prepared.merged_commit).await
    {
        tracing::warn!(error = %error, "finalize 清理 source update staged ref 失败");
    }

    if may_remove_files {
        if let Err(error) = remove_file_if_exists(&sidecar_path).await {
            tracing::warn!(error = %error, "finalize 清理 source update metadata 失败");
        }
        if let Err(error) = remove_file_if_exists(&staged).await {
            tracing::warn!(error = %error, "finalize 清理残留 staged 二进制失败");
        }
    }
}

async fn validate_config(
    config: &SourceUpdateConfig,
) -> Result<ValidatedConfig, AdminServiceError> {
    if !config.repo_path.is_absolute() {
        return Err(invalid("源码仓库路径必须是绝对路径"));
    }
    if config.branch.is_empty() || config.branch.trim() != config.branch {
        return Err(invalid("源码更新 branch 不能为空或包含首尾空白"));
    }
    if !is_safe_branch_name(&config.branch) {
        return Err(invalid("源码更新 branch 不符合严格安全 ref 规则"));
    }
    validate_nonempty_config_value("upstream git URL", &config.upstream_git_url)?;
    if config.upstream_git_url.starts_with('-') {
        return Err(invalid("upstream git URL 不能以 '-' 开头"));
    }
    if config.upstream_git_url != TRUSTED_SOURCE_UPSTREAM {
        #[cfg(test)]
        if !Path::new(&config.upstream_git_url).is_absolute() {
            return Err(invalid(format!(
                "source 更新只信任官方上游 {}",
                TRUSTED_SOURCE_UPSTREAM
            )));
        }
        #[cfg(not(test))]
        return Err(invalid(format!(
            "source 更新只信任官方上游 {}",
            TRUSTED_SOURCE_UPSTREAM
        )));
    }
    validate_nonempty_config_value("build PATH", &config.build_path)?;

    let canonical = tokio::fs::canonicalize(&config.repo_path)
        .await
        .map_err(|error| {
            internal(format!(
                "canonicalize 源码仓库路径 {} 失败: {error}",
                config.repo_path.display()
            ))
        })?;
    let metadata = tokio::fs::metadata(&canonical).await.map_err(|error| {
        internal(format!(
            "读取源码仓库路径 {} 失败: {error}",
            canonical.display()
        ))
    })?;
    if !metadata.is_dir() {
        return Err(invalid("canonical 源码仓库路径不是目录"));
    }
    let canonical_repo = canonical
        .to_str()
        .ok_or_else(|| invalid("canonical 源码仓库路径必须是有效 UTF-8"))?
        .to_owned();

    Ok(ValidatedConfig {
        repo_path: canonical,
        canonical_repo,
        branch: config.branch.clone(),
        upstream_git_url: config.upstream_git_url.clone(),
        build_path: config.build_path.clone(),
    })
}

fn validate_nonempty_config_value(name: &str, value: &str) -> Result<(), AdminServiceError> {
    if value.is_empty() || value.trim().is_empty() {
        return Err(invalid(format!("{name} 不能为空")));
    }
    if value.chars().any(char::is_control) {
        return Err(invalid(format!("{name} 不能包含控制字符")));
    }
    Ok(())
}

fn validate_staged_path(staged: &Path) -> Result<(), AdminServiceError> {
    if staged.as_os_str().is_empty() || staged.file_name().is_none() {
        return Err(invalid("staged 路径必须指向文件"));
    }
    Ok(())
}

async fn validate_staged_destination(
    config: &ValidatedConfig,
    staged: &Path,
) -> Result<PathBuf, AdminServiceError> {
    validate_staged_path(staged)?;
    let parent = usable_parent(staged);
    let canonical_parent = tokio::fs::canonicalize(parent).await.map_err(|error| {
        internal(format!(
            "canonicalize staged 父目录 {} 失败: {error}",
            parent.display()
        ))
    })?;
    let file_name = staged
        .file_name()
        .ok_or_else(|| invalid("staged 路径必须指向文件"))?;
    let canonical_staged = canonical_parent.join(file_name);

    let lexical_staged = if staged.is_absolute() {
        staged.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| internal(format!("读取当前目录失败: {error}")))?
            .join(staged)
    };
    if lexical_staged.starts_with(&config.repo_path)
        || canonical_staged.starts_with(&config.repo_path)
    {
        return Err(invalid(
            "staged 及 sidecar 必须位于主源码仓库之外，拒绝修改主 worktree/.git",
        ));
    }
    Ok(canonical_staged)
}

async fn preflight(config: &ValidatedConfig) -> Result<Preflight, AdminServiceError> {
    let status = run_command(
        config,
        "git",
        git_repo_args(
            config,
            ["status", "--porcelain=v1", "--untracked-files=all"],
        ),
        None,
        QUICK_TIMEOUT,
        "检查源码仓库状态",
    )
    .await?;
    ensure_internal_success("检查源码仓库状态", &status)?;
    if !status.stdout.bytes.is_empty() {
        return Err(invalid(format!(
            "源码仓库存在未提交或未跟踪改动，拒绝更新:\n{}",
            render_stream(&status.stdout)
        )));
    }

    let branch = run_command(
        config,
        "git",
        git_repo_args(config, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
        None,
        QUICK_TIMEOUT,
        "读取当前源码分支",
    )
    .await?;
    if !branch.status.success() {
        return Err(invalid(command_failure_message(
            "当前 checkout 不是可提升的本地分支",
            &branch,
        )));
    }
    let branch = stdout_text("当前源码分支", &branch)?.trim().to_owned();
    if branch != config.branch {
        return Err(invalid(format!(
            "当前源码分支为 {branch}，配置要求 {}",
            config.branch
        )));
    }

    let head = read_repo_head(config).await?;

    let top_level = run_command(
        config,
        "git",
        git_repo_args(config, ["rev-parse", "--show-toplevel"]),
        None,
        QUICK_TIMEOUT,
        "确认源码仓库 top-level",
    )
    .await?;
    ensure_internal_success("确认源码仓库 top-level", &top_level)?;
    let top_level = stdout_text("源码仓库 top-level", &top_level)?
        .trim()
        .to_owned();
    let top_level = tokio::fs::canonicalize(&top_level).await.map_err(|error| {
        internal(format!(
            "canonicalize git top-level {top_level} 失败: {error}"
        ))
    })?;
    if top_level != config.repo_path {
        return Err(invalid(format!(
            "repo_path 必须正好是 git top-level；配置为 {}，实际为 {}",
            config.repo_path.display(),
            top_level.display()
        )));
    }

    Ok(Preflight { head })
}

async fn read_repo_head(config: &ValidatedConfig) -> Result<String, AdminServiceError> {
    let output = run_command(
        config,
        "git",
        git_repo_args(config, ["rev-parse", "--verify", "HEAD^{commit}"]),
        None,
        QUICK_TIMEOUT,
        "读取源码仓库 HEAD",
    )
    .await?;
    ensure_internal_success("读取源码仓库 HEAD", &output)?;
    parse_oid(
        "源码仓库 HEAD",
        stdout_text("源码仓库 HEAD", &output)?.trim(),
    )
}

async fn fetch_release_tag(
    config: &ValidatedConfig,
    tag: &str,
    fetched_ref: &str,
) -> Result<(), AdminServiceError> {
    if !is_fetched_ref(fetched_ref) {
        return Err(internal("拒绝写入 fetched ref 命名空间之外的 ref"));
    }
    let refspec = format!("refs/tags/{tag}:{fetched_ref}");
    let output = run_command(
        config,
        "git",
        vec![
            os("-C"),
            config.repo_path.as_os_str().to_owned(),
            os("fetch"),
            os("--no-tags"),
            os("--no-write-fetch-head"),
            OsString::from(&config.upstream_git_url),
            OsString::from(refspec),
        ],
        None,
        GIT_FETCH_TIMEOUT,
        "fetch 官方 release tag",
    )
    .await?;
    ensure_internal_success("fetch 官方 release tag", &output)
}

async fn add_detached_worktree(
    config: &ValidatedConfig,
    worktree: &Path,
    base_head: &str,
) -> Result<(), AdminServiceError> {
    let output = run_command(
        config,
        "git",
        vec![
            os("-C"),
            config.repo_path.as_os_str().to_owned(),
            os("worktree"),
            os("add"),
            os("--detach"),
            worktree.as_os_str().to_owned(),
            OsString::from(base_head),
        ],
        None,
        GIT_WORKTREE_TIMEOUT,
        "创建 detached 临时 worktree",
    )
    .await?;
    ensure_internal_success("创建 detached 临时 worktree", &output)
}

async fn merge_fetched_ref(
    config: &ValidatedConfig,
    worktree: &Path,
    fetched_ref: &str,
) -> Result<(), AdminServiceError> {
    if !is_fetched_ref(fetched_ref) {
        return Err(internal("拒绝合并 fetched ref 命名空间之外的 ref"));
    }
    let output = run_command(
        config,
        "git",
        vec![
            os("-C"),
            worktree.as_os_str().to_owned(),
            os("-c"),
            os("user.name=kiro-rs-updater"),
            os("-c"),
            os("user.email=updater@localhost"),
            os("merge"),
            os("--no-edit"),
            os("--no-ff"),
            os("--no-gpg-sign"),
            os("--"),
            OsString::from(fetched_ref),
        ],
        None,
        GIT_MERGE_TIMEOUT,
        "合并官方 release tag",
    )
    .await?;
    if output.status.success() {
        return Ok(());
    }

    let conflicts = run_command(
        config,
        "git",
        vec![
            os("-C"),
            worktree.as_os_str().to_owned(),
            os("diff"),
            os("--name-only"),
            os("--diff-filter=U"),
            os("--"),
        ],
        None,
        QUICK_TIMEOUT,
        "收集合并冲突文件",
    )
    .await?;
    ensure_internal_success("收集合并冲突文件", &conflicts)?;
    let conflict_text = stdout_text_lossy(&conflicts);
    let conflict_files: Vec<_> = conflict_text
        .lines()
        .filter(|line| !line.is_empty())
        .take(100)
        .map(sanitize_text)
        .collect();
    if !conflict_files.is_empty() {
        return Err(invalid(format!(
            "源码合并冲突；冲突文件:\n- {}",
            conflict_files.join("\n- ")
        )));
    }

    Err(internal(command_failure_message(
        "合并官方 release tag",
        &output,
    )))
}

async fn read_worktree_head(
    config: &ValidatedConfig,
    worktree: &Path,
) -> Result<String, AdminServiceError> {
    let output = run_command(
        config,
        "git",
        vec![
            os("-C"),
            worktree.as_os_str().to_owned(),
            os("rev-parse"),
            os("--verify"),
            os("HEAD^{commit}"),
        ],
        None,
        QUICK_TIMEOUT,
        "读取合并提交",
    )
    .await?;
    ensure_internal_success("读取合并提交", &output)?;
    parse_oid("合并提交", stdout_text("合并提交", &output)?.trim())
}

async fn create_staged_ref(
    config: &ValidatedConfig,
    staged_ref: &str,
    merged_commit: &str,
) -> Result<(), AdminServiceError> {
    if !is_staged_ref(staged_ref) || !is_valid_oid(merged_commit) {
        return Err(internal("拒绝创建不安全的 staged ref"));
    }
    let zero_oid = "0".repeat(merged_commit.len());
    let output = run_command(
        config,
        "git",
        git_repo_os_args(
            config,
            [
                os("update-ref"),
                OsString::from(staged_ref),
                OsString::from(merged_commit),
                OsString::from(zero_oid),
            ],
        ),
        None,
        QUICK_TIMEOUT,
        "保存 staged commit ref",
    )
    .await?;
    ensure_internal_success("保存 staged commit ref", &output)
}

async fn build_and_stage(
    config: &ValidatedConfig,
    worktree: &Path,
    staged: &Path,
    job_id: &str,
) -> Result<(), AdminServiceError> {
    let frontend = worktree.join("admin-ui");
    let package_json = frontend.join("package.json");
    if !path_exists(&package_json).await? {
        return Err(internal(format!(
            "临时 worktree 缺少前端 package.json: {}",
            package_json.display()
        )));
    }

    let package_lock = frontend.join("package-lock.json");
    if !path_exists(&package_lock).await? {
        return Err(invalid(format!(
            "源码更新要求锁定前端依赖，但缺少 {}",
            package_lock.display()
        )));
    }
    let install = run_command(
        config,
        "npm",
        vec![os("ci"), os("--no-audit"), os("--no-fund")],
        Some(&frontend),
        NPM_INSTALL_TIMEOUT,
        "安装前端依赖",
    )
    .await?;
    ensure_internal_success("安装前端依赖", &install)?;

    run_required_command(
        config,
        "npm",
        vec![os("run"), os("build")],
        worktree.join("admin-ui"),
        NPM_BUILD_TIMEOUT,
        "构建前端",
    )
    .await?;
    run_required_command(
        config,
        "cargo",
        vec![os("check"), os("--locked")],
        worktree.to_path_buf(),
        CARGO_CHECK_TIMEOUT,
        "cargo check --locked",
    )
    .await?;
    run_required_command(
        config,
        "cargo",
        vec![os("test"), os("--locked")],
        worktree.to_path_buf(),
        CARGO_TEST_TIMEOUT,
        "cargo test --locked",
    )
    .await?;
    run_required_command(
        config,
        "cargo",
        vec![os("build"), os("--release"), os("--locked")],
        worktree.to_path_buf(),
        CARGO_BUILD_TIMEOUT,
        "cargo build --release --locked",
    )
    .await?;

    let binary = worktree.join("target").join("release").join(binary_name());
    stage_binary_atomic(&binary, staged, job_id).await
}

async fn run_required_command(
    config: &ValidatedConfig,
    program: &str,
    args: Vec<OsString>,
    cwd: PathBuf,
    command_timeout: Duration,
    label: &'static str,
) -> Result<(), AdminServiceError> {
    let output = run_command(config, program, args, Some(&cwd), command_timeout, label).await?;
    ensure_internal_success(label, &output)
}

async fn stage_binary_atomic(
    source: &Path,
    staged: &Path,
    job_id: &str,
) -> Result<(), AdminServiceError> {
    if !is_nonempty_regular_file(source).await? {
        return Err(internal(format!(
            "release 构建产物不存在、为空或不是普通文件: {}",
            source.display()
        )));
    }
    let parent = usable_parent(staged);
    let parent_metadata = tokio::fs::metadata(parent).await.map_err(|error| {
        internal(format!(
            "读取 staged 父目录 {} 失败: {error}",
            parent.display()
        ))
    })?;
    if !parent_metadata.is_dir() {
        return Err(invalid("staged 父路径不是目录"));
    }

    let temporary = appended_path(staged, &format!(".tmp-{job_id}"));
    let result = async {
        remove_file_if_exists(&temporary).await?;
        tokio::fs::copy(source, &temporary).await.map_err(|error| {
            internal(format!(
                "复制 release 二进制 {} 到 {} 失败: {error}",
                source.display(),
                temporary.display()
            ))
        })?;
        set_executable(&temporary).await?;
        let file = tokio::fs::OpenOptions::new()
            .read(true)
            .open(&temporary)
            .await
            .map_err(|error| internal(format!("打开 staged 临时文件失败: {error}")))?;
        file.sync_all()
            .await
            .map_err(|error| internal(format!("同步 staged 临时文件失败: {error}")))?;
        if !is_nonempty_regular_file(&temporary).await? {
            return Err(internal("复制后的 staged 临时二进制为空或类型无效"));
        }
        ensure_path_absent(staged).await?;
        tokio::fs::rename(&temporary, staged)
            .await
            .map_err(|error| internal(format!("原子发布 staged 二进制失败: {error}")))?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = remove_file_if_exists(&temporary).await;
    }
    result
}

#[cfg(unix)]
async fn set_executable(path: &Path) -> Result<(), AdminServiceError> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = tokio::fs::metadata(path)
        .await
        .map_err(|error| internal(format!("读取 staged 二进制权限失败: {error}")))?
        .permissions();
    permissions.set_mode(0o755);
    tokio::fs::set_permissions(path, permissions)
        .await
        .map_err(|error| internal(format!("设置 staged 二进制可执行权限失败: {error}")))
}

#[cfg(not(unix))]
async fn set_executable(_path: &Path) -> Result<(), AdminServiceError> {
    Ok(())
}

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "kiro-rs.exe"
    } else {
        "kiro-rs"
    }
}

async fn try_reuse(
    config: &ValidatedConfig,
    version: &str,
    tag: &str,
    base_head: &str,
    staged: &Path,
    metadata: Option<&SourceUpdateSidecar>,
) -> Result<Option<PreparedSourceUpdate>, AdminServiceError> {
    let Some(metadata) = metadata else {
        return Ok(None);
    };
    if metadata.version != version
        || metadata.tag != tag
        || metadata.canonical_repo != config.canonical_repo
        || metadata.branch != config.branch
        || metadata.upstream_git_url != config.upstream_git_url
        || metadata.base_head != base_head
        || !valid_sidecar(metadata)
        || !is_nonempty_regular_file(staged).await?
    {
        return Ok(None);
    }

    let Some(resolved) = resolve_ref(config, &metadata.staged_ref).await? else {
        return Ok(None);
    };
    if resolved != metadata.merged_commit {
        return Ok(None);
    }

    Ok(Some(PreparedSourceUpdate {
        version: metadata.version.clone(),
        tag: metadata.tag.clone(),
        base_head: metadata.base_head.clone(),
        merged_commit: metadata.merged_commit.clone(),
        staged_ref: metadata.staged_ref.clone(),
        reused: true,
        output: format!(
            "复用已校验的源码更新产物 {} ({})",
            metadata.tag, metadata.merged_commit
        ),
    }))
}

fn valid_sidecar(metadata: &SourceUpdateSidecar) -> bool {
    is_normalized_version(&metadata.version)
        && validate_tag(&metadata.tag, &metadata.version).is_ok()
        && is_valid_oid(&metadata.base_head)
        && is_valid_oid(&metadata.merged_commit)
        && is_staged_ref(&metadata.staged_ref)
        && chrono::DateTime::parse_from_rfc3339(&metadata.created_at).is_ok()
}

fn sidecar_matches_prepared(
    metadata: &SourceUpdateSidecar,
    config: &ValidatedConfig,
    prepared: &PreparedSourceUpdate,
) -> bool {
    valid_sidecar(metadata)
        && metadata.version == prepared.version
        && metadata.tag == prepared.tag
        && metadata.canonical_repo == config.canonical_repo
        && metadata.branch == config.branch
        && metadata.upstream_git_url == config.upstream_git_url
        && metadata.base_head == prepared.base_head
        && metadata.merged_commit == prepared.merged_commit
        && metadata.staged_ref == prepared.staged_ref
}

fn validate_prepared(prepared: &PreparedSourceUpdate) -> Result<(), AdminServiceError> {
    if !is_normalized_version(&prepared.version) {
        return Err(invalid("prepared version 不符合严格安全规则"));
    }
    validate_tag(&prepared.tag, &prepared.version)?;
    if !is_valid_oid(&prepared.base_head) || !is_valid_oid(&prepared.merged_commit) {
        return Err(invalid("prepared commit id 不符合严格安全规则"));
    }
    if !is_staged_ref(&prepared.staged_ref) {
        return Err(invalid("prepared staged ref 超出允许的命名空间"));
    }
    Ok(())
}

async fn resolve_ref(
    config: &ValidatedConfig,
    ref_name: &str,
) -> Result<Option<String>, AdminServiceError> {
    if !is_staged_ref(ref_name) {
        return Ok(None);
    }
    let output = run_command(
        config,
        "git",
        git_repo_os_args(
            config,
            [
                os("show-ref"),
                os("--verify"),
                os("--hash"),
                OsString::from(ref_name),
            ],
        ),
        None,
        QUICK_TIMEOUT,
        "解析 staged ref",
    )
    .await?;
    if !output.status.success() {
        if output.status.code() == Some(1) {
            return Ok(None);
        }
        return Err(internal(command_failure_message(
            "解析 staged ref",
            &output,
        )));
    }
    Ok(Some(parse_oid(
        "staged ref",
        stdout_text("staged ref", &output)?.trim(),
    )?))
}

async fn cleanup_previous(
    config: &ValidatedConfig,
    staged: &Path,
    sidecar_path: &Path,
    metadata: Option<&SourceUpdateSidecar>,
) -> Result<(), AdminServiceError> {
    let mut errors = Vec::new();
    if let Some(metadata) = metadata {
        if is_staged_ref(&metadata.staged_ref) && is_valid_oid(&metadata.merged_commit) {
            if let Err(error) =
                delete_staged_ref_cas(config, &metadata.staged_ref, &metadata.merged_commit).await
            {
                errors.push(error.to_string());
            }
        }
    }
    for path in [staged, sidecar_path] {
        if let Err(error) = remove_file_if_exists(path).await {
            errors.push(error.to_string());
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(internal(format!(
            "清理旧 source update 产物失败: {}",
            errors.join("; ")
        )))
    }
}

async fn cleanup_job(
    config: &ValidatedConfig,
    worktree: Option<&Path>,
    temp_root: &Path,
    fetched_ref: &str,
) -> Vec<String> {
    let mut errors = Vec::new();
    if let Some(worktree) = worktree {
        match run_command(
            config,
            "git",
            vec![
                os("-C"),
                config.repo_path.as_os_str().to_owned(),
                os("worktree"),
                os("remove"),
                os("--force"),
                worktree.as_os_str().to_owned(),
            ],
            None,
            GIT_WORKTREE_TIMEOUT,
            "删除 detached 临时 worktree",
        )
        .await
        {
            Ok(output) if output.status.success() => {}
            Ok(output) => errors.push(command_failure_message(
                "删除 detached 临时 worktree",
                &output,
            )),
            Err(error) => errors.push(error.to_string()),
        }
    }

    if let Err(error) = remove_dir_all_if_exists(temp_root).await {
        errors.push(error.to_string());
    }
    if is_fetched_ref(fetched_ref) {
        if let Err(error) = delete_namespaced_ref(config, fetched_ref).await {
            errors.push(error.to_string());
        }
    } else {
        errors.push("拒绝删除 fetched ref 命名空间之外的 ref".to_string());
    }
    errors
}

async fn cleanup_failed_prepare(
    config: &ValidatedConfig,
    staged: &Path,
    sidecar_path: &Path,
    staged_ref: &str,
    created_staged_commit: Option<&str>,
) -> Vec<String> {
    let mut errors = Vec::new();
    if let Some(created_staged_commit) = created_staged_commit {
        if let Err(error) = delete_staged_ref_cas(config, staged_ref, created_staged_commit).await {
            errors.push(error.to_string());
        }
    }
    for path in [staged, sidecar_path] {
        if let Err(error) = remove_file_if_exists(path).await {
            errors.push(error.to_string());
        }
    }
    errors
}

async fn delete_namespaced_ref(
    config: &ValidatedConfig,
    ref_name: &str,
) -> Result<(), AdminServiceError> {
    if !is_staged_ref(ref_name) && !is_fetched_ref(ref_name) {
        return Err(internal("拒绝删除 source update 命名空间之外的 ref"));
    }
    let output = run_command(
        config,
        "git",
        git_repo_os_args(
            config,
            [os("update-ref"), os("-d"), OsString::from(ref_name)],
        ),
        None,
        QUICK_TIMEOUT,
        "删除 source update 临时 ref",
    )
    .await?;
    ensure_internal_success("删除 source update 临时 ref", &output)
}

async fn delete_staged_ref_cas(
    config: &ValidatedConfig,
    ref_name: &str,
    expected_commit: &str,
) -> Result<(), AdminServiceError> {
    if !is_staged_ref(ref_name) || !is_valid_oid(expected_commit) {
        return Err(internal("拒绝删除不安全的 staged ref"));
    }
    let output = run_command(
        config,
        "git",
        git_repo_os_args(
            config,
            [
                os("update-ref"),
                os("-d"),
                OsString::from(ref_name),
                OsString::from(expected_commit),
            ],
        ),
        None,
        QUICK_TIMEOUT,
        "CAS 删除 staged ref",
    )
    .await?;
    ensure_internal_success("CAS 删除 staged ref", &output)
}

async fn read_sidecar_lenient(
    path: &Path,
) -> Result<Option<SourceUpdateSidecar>, AdminServiceError> {
    let metadata = match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(internal(format!(
                "读取 source update metadata {} 失败: {error}",
                path.display()
            )));
        }
    };
    if !metadata.file_type().is_file() || metadata.len() > MAX_SIDECAR_BYTES {
        return Ok(None);
    }
    let bytes = tokio::fs::read(path).await.map_err(|error| {
        internal(format!(
            "读取 source update metadata {} 失败: {error}",
            path.display()
        ))
    })?;
    match serde_json::from_slice(&bytes) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(_) => Ok(None),
    }
}

async fn write_sidecar_atomic(
    path: &Path,
    metadata: &SourceUpdateSidecar,
    job_id: &str,
) -> Result<(), AdminServiceError> {
    let bytes = serde_json::to_vec_pretty(metadata)
        .map_err(|error| internal(format!("序列化 source update metadata 失败: {error}")))?;
    let temporary = appended_path(path, &format!(".tmp-{job_id}"));
    let result = async {
        remove_file_if_exists(&temporary).await?;
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await
            .map_err(|error| internal(format!("创建 metadata 临时文件失败: {error}")))?;
        file.write_all(&bytes)
            .await
            .map_err(|error| internal(format!("写入 metadata 临时文件失败: {error}")))?;
        file.flush()
            .await
            .map_err(|error| internal(format!("flush metadata 临时文件失败: {error}")))?;
        file.sync_all()
            .await
            .map_err(|error| internal(format!("同步 metadata 临时文件失败: {error}")))?;
        drop(file);
        ensure_path_absent(path).await?;
        tokio::fs::rename(&temporary, path)
            .await
            .map_err(|error| internal(format!("原子发布 source update metadata 失败: {error}")))
    }
    .await;
    if result.is_err() {
        let _ = remove_file_if_exists(&temporary).await;
    }
    result
}

async fn is_nonempty_regular_file(path: &Path) -> Result<bool, AdminServiceError> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => Ok(metadata.file_type().is_file() && metadata.len() > 0),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(internal(format!(
            "读取文件 {} metadata 失败: {error}",
            path.display()
        ))),
    }
}

async fn path_exists(path: &Path) -> Result<bool, AdminServiceError> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(internal(format!(
            "读取路径 {} metadata 失败: {error}",
            path.display()
        ))),
    }
}

async fn ensure_path_absent(path: &Path) -> Result<(), AdminServiceError> {
    match tokio::fs::symlink_metadata(path).await {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(internal(format!(
            "检查目标路径 {} 失败: {error}",
            path.display()
        ))),
        Ok(_) => Err(internal(format!(
            "目标路径 {} 在发布期间被并发创建，拒绝覆盖",
            path.display()
        ))),
    }
}

async fn remove_file_if_exists(path: &Path) -> Result<(), AdminServiceError> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(internal(format!(
            "删除文件 {} 失败: {error}",
            path.display()
        ))),
    }
}

async fn remove_dir_all_if_exists(path: &Path) -> Result<(), AdminServiceError> {
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(internal(format!(
            "删除临时目录 {} 失败: {error}",
            path.display()
        ))),
    }
}

async fn run_command(
    config: &ValidatedConfig,
    program: &str,
    args: Vec<OsString>,
    cwd: Option<&Path>,
    command_timeout: Duration,
    label: &'static str,
) -> Result<CommandOutput, AdminServiceError> {
    let mut command = Command::new(program);
    command
        .args(args)
        .env("PATH", &config.build_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("CI", "true")
        .env_remove("CARGO_TARGET_DIR")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_NAMESPACE")
        .env_remove("GIT_CONFIG_COUNT")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }

    let mut child = command
        .spawn()
        .map_err(|error| internal(format!("启动外部命令“{label}”失败: {error}")))?;
    let process_id = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| internal(format!("外部命令“{label}”缺少 stdout pipe")))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| internal(format!("外部命令“{label}”缺少 stderr pipe")))?;
    let stdout_task = tokio::spawn(drain_limited(stdout));
    let stderr_task = tokio::spawn(drain_limited(stderr));

    let mut status = None;
    let mut wait_error = None;
    match timeout(command_timeout, child.wait()).await {
        Ok(Ok(exit_status)) => status = Some(exit_status),
        Ok(Err(error)) => {
            let _ = terminate_process_tree(&mut child, process_id);
            let _ = timeout(DRAIN_TIMEOUT, child.wait()).await;
            wait_error = Some(format!("等待外部命令“{label}”失败: {error}"));
        }
        Err(_) => {
            let kill_error = terminate_process_tree(&mut child, process_id);
            let _ = timeout(DRAIN_TIMEOUT, child.wait()).await;
            wait_error = Some(match kill_error {
                Some(error) => format!(
                    "外部命令“{label}”超过 {} 秒且终止失败: {error}",
                    command_timeout.as_secs()
                ),
                None => format!(
                    "外部命令“{label}”超过 {} 秒，已终止",
                    command_timeout.as_secs()
                ),
            });
        }
    }

    #[cfg(unix)]
    if status.is_some() {
        // 清理由命令后台化后仍继承 stdout/stderr 的同进程组后代。
        let _ = terminate_process_group(process_id);
    }

    let (stdout, stderr) = tokio::join!(finish_capture(stdout_task), finish_capture(stderr_task));
    let stdout = stdout?;
    let stderr = stderr?;
    if let Some(wait_error) = wait_error {
        return Err(internal(format!(
            "{wait_error}\nstdout: {}\nstderr: {}",
            render_stream(&stdout),
            render_stream(&stderr)
        )));
    }

    Ok(CommandOutput {
        status: status.ok_or_else(|| internal(format!("外部命令“{label}”没有退出状态")))?,
        stdout,
        stderr,
    })
}

#[cfg(unix)]
fn terminate_process_group(process_id: Option<u32>) -> Option<io::Error> {
    let process_id = process_id?;
    let Ok(process_id) = i32::try_from(process_id) else {
        return Some(io::Error::new(
            io::ErrorKind::InvalidInput,
            "child process id 超出 i32 范围",
        ));
    };
    // SAFETY: 负 PID 是 POSIX 的进程组寻址方式；该组由本次 Command
    // 的 process_group(0) 创建，signal 9 不涉及 Rust 内存安全。
    if unsafe { kill(-process_id, 9) } == 0 {
        None
    } else {
        let error = io::Error::last_os_error();
        // ESRCH 表示该命令及其所有后代已经退出。
        if error.raw_os_error() == Some(3) {
            None
        } else {
            Some(error)
        }
    }
}

#[cfg(unix)]
fn terminate_process_tree(
    child: &mut tokio::process::Child,
    process_id: Option<u32>,
) -> Option<io::Error> {
    let group_error = terminate_process_group(process_id);
    let child_error = child.start_kill().err();
    group_error.or(child_error)
}

#[cfg(not(unix))]
fn terminate_process_tree(
    child: &mut tokio::process::Child,
    _process_id: Option<u32>,
) -> Option<io::Error> {
    child.start_kill().err()
}

async fn drain_limited<R>(mut reader: R) -> io::Result<CapturedStream>
where
    R: AsyncRead + Unpin,
{
    let mut captured = CapturedStream::default();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            return Ok(captured);
        }
        let remaining = MAX_CAPTURE_BYTES.saturating_sub(captured.bytes.len());
        if remaining > 0 {
            let keep = remaining.min(read);
            captured.bytes.extend_from_slice(&buffer[..keep]);
        }
        if read > remaining {
            captured.truncated = true;
        }
    }
}

async fn finish_capture(
    mut task: JoinHandle<io::Result<CapturedStream>>,
) -> Result<CapturedStream, AdminServiceError> {
    match timeout(DRAIN_TIMEOUT, &mut task).await {
        Ok(Ok(Ok(captured))) => Ok(captured),
        Ok(Ok(Err(error))) => Err(internal(format!("读取外部命令输出失败: {error}"))),
        Ok(Err(error)) => Err(internal(format!("外部命令输出任务失败: {error}"))),
        Err(_) => {
            task.abort();
            Err(internal("等待外部命令输出关闭超时"))
        }
    }
}

fn ensure_internal_success(label: &str, output: &CommandOutput) -> Result<(), AdminServiceError> {
    if output.status.success() {
        Ok(())
    } else {
        Err(internal(command_failure_message(label, output)))
    }
}

fn command_failure_message(label: &str, output: &CommandOutput) -> String {
    let status = output
        .status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "terminated-by-signal".to_string());
    format!(
        "{label}失败（exit={status}）\nstdout: {}\nstderr: {}",
        render_stream(&output.stdout),
        render_stream(&output.stderr)
    )
}

fn render_stream(stream: &CapturedStream) -> String {
    let keep = stream.bytes.len().min(MAX_ERROR_OUTPUT_BYTES);
    let mut rendered = sanitize_text(&String::from_utf8_lossy(&stream.bytes[..keep]));
    if keep < stream.bytes.len() || stream.truncated {
        rendered.push_str("\n...[output truncated]");
    }
    if rendered.is_empty() {
        rendered.push_str("<empty>");
    }
    rendered
}

fn sanitize_text(text: &str) -> String {
    text.chars()
        .map(|character| {
            if character.is_control() && !matches!(character, '\n' | '\r' | '\t') {
                '�'
            } else {
                character
            }
        })
        .collect()
}

fn stdout_text<'a>(label: &str, output: &'a CommandOutput) -> Result<&'a str, AdminServiceError> {
    std::str::from_utf8(&output.stdout.bytes)
        .map_err(|error| internal(format!("{label} 输出不是 UTF-8: {error}")))
}

fn stdout_text_lossy(output: &CommandOutput) -> String {
    String::from_utf8_lossy(&output.stdout.bytes).into_owned()
}

fn git_repo_args<const N: usize>(config: &ValidatedConfig, args: [&str; N]) -> Vec<OsString> {
    let mut result = Vec::with_capacity(N + 2);
    result.push(os("-C"));
    result.push(config.repo_path.as_os_str().to_owned());
    result.extend(args.into_iter().map(OsString::from));
    result
}

fn git_repo_os_args<const N: usize>(
    config: &ValidatedConfig,
    args: [OsString; N],
) -> Vec<OsString> {
    let mut result = Vec::with_capacity(N + 2);
    result.push(os("-C"));
    result.push(config.repo_path.as_os_str().to_owned());
    result.extend(args);
    result
}

fn os(value: &str) -> OsString {
    OsString::from(value)
}

fn normalize_version(input: &str) -> Result<String, AdminServiceError> {
    if input.is_empty() || input.trim() != input {
        return Err(invalid("版本号不能为空或包含首尾空白"));
    }
    let version = input.strip_prefix('v').unwrap_or(input);
    if version.is_empty() || version.len() > 128 {
        return Err(invalid("版本号长度无效"));
    }
    if !version
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || ".+-_".contains(character))
        || !version
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric())
        || !version
            .chars()
            .last()
            .is_some_and(|character| character.is_ascii_alphanumeric())
        || version.contains("..")
    {
        return Err(invalid("版本号不符合严格安全规则"));
    }
    Ok(version.to_string())
}

fn is_normalized_version(version: &str) -> bool {
    normalize_version(version).is_ok_and(|normalized| normalized == version)
}

fn validate_tag(tag: &str, version: &str) -> Result<(), AdminServiceError> {
    if tag != format!("v{version}") || !is_safe_ref_component(tag) {
        return Err(invalid("release tag 不符合严格安全规则"));
    }
    Ok(())
}

fn is_safe_ref_component(component: &str) -> bool {
    !component.is_empty()
        && component.len() <= 160
        && component
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".+-_".contains(character))
        && component
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric())
        && !component.ends_with('.')
        && !component.ends_with(".lock")
        && !component.contains("..")
}

fn is_safe_branch_name(branch: &str) -> bool {
    !branch.is_empty()
        && branch.len() <= 255
        && !branch.starts_with('-')
        && !branch.starts_with('/')
        && !branch.ends_with('/')
        && !branch.contains("//")
        && !branch.contains("@{")
        && branch.split('/').all(is_safe_ref_component)
}

fn is_namespaced_ref(ref_name: &str, prefix: &str) -> bool {
    ref_name
        .strip_prefix(prefix)
        .is_some_and(is_safe_ref_component)
}

fn is_fetched_ref(ref_name: &str) -> bool {
    is_namespaced_ref(ref_name, FETCHED_REF_PREFIX)
}

fn is_staged_ref(ref_name: &str) -> bool {
    is_namespaced_ref(ref_name, STAGED_REF_PREFIX)
}

fn is_valid_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn parse_oid(label: &str, value: &str) -> Result<String, AdminServiceError> {
    if is_valid_oid(value) {
        Ok(value.to_ascii_lowercase())
    } else {
        Err(internal(format!("{label} 不是有效的 git object id")))
    }
}

fn sidecar_path(staged: &Path) -> PathBuf {
    appended_path(staged, ".source.json")
}

fn appended_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn usable_parent(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

fn invalid(message: impl Into<String>) -> AdminServiceError {
    AdminServiceError::InvalidCredential(message.into())
}

fn internal(message: impl Into<String>) -> AdminServiceError {
    AdminServiceError::InternalError(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_normalization_accepts_safe_release_versions() {
        assert_eq!(normalize_version("1.2.3").unwrap(), "1.2.3");
        assert_eq!(
            normalize_version("v1.2.3-rc.1+build7").unwrap(),
            "1.2.3-rc.1+build7"
        );
    }

    #[test]
    fn version_normalization_rejects_unsafe_values() {
        for version in [
            "",
            " 1.2.3",
            "1.2.3 ",
            "../1.2.3",
            "1.2.3/evil",
            "1.2.3^{commit}",
            "-1.2.3",
            "1.2.3.",
            "1..2",
            "版本1",
        ] {
            assert!(normalize_version(version).is_err(), "accepted {version:?}");
        }
    }

    #[test]
    fn branch_and_namespaced_refs_are_strictly_scoped() {
        assert!(is_safe_branch_name("main"));
        assert!(is_safe_branch_name("release/1.2.x"));
        assert!(!is_safe_branch_name("-main"));
        assert!(!is_safe_branch_name("refs//heads/main"));
        assert!(!is_safe_branch_name("release/../main"));
        assert!(!is_safe_branch_name("main.lock"));
        assert!(!is_safe_branch_name("feature/@{upstream}"));

        let job = "f7cbaf77-8c0b-4f4e-b64e-339e2cb32a6d";
        assert!(is_fetched_ref(&format!("{FETCHED_REF_PREFIX}{job}")));
        assert!(is_staged_ref(&format!("{STAGED_REF_PREFIX}{job}")));
        assert!(!is_staged_ref("refs/heads/main"));
        assert!(!is_staged_ref(
            "refs/kiro-source-update/staged/../../heads/main"
        ));
    }

    #[test]
    fn sidecar_path_appends_suffix_without_replacing_extension() {
        assert_eq!(
            sidecar_path(Path::new("/tmp/kiro-rs")),
            PathBuf::from("/tmp/kiro-rs.source.json")
        );
        assert_eq!(
            sidecar_path(Path::new("C:/staging/kiro-rs.exe")),
            PathBuf::from("C:/staging/kiro-rs.exe.source.json")
        );
    }

    #[test]
    fn oid_validation_accepts_sha1_and_sha256_only() {
        assert!(is_valid_oid(&"a".repeat(40)));
        assert!(is_valid_oid(&"B".repeat(64)));
        assert!(!is_valid_oid(&"a".repeat(39)));
        assert!(!is_valid_oid(&format!("{}g", "a".repeat(39))));
    }

    #[test]
    fn rendered_command_output_is_bounded() {
        let stream = CapturedStream {
            bytes: vec![b'x'; MAX_CAPTURE_BYTES],
            truncated: true,
        };
        let rendered = render_stream(&stream);
        assert!(rendered.len() < MAX_ERROR_OUTPUT_BYTES + 64);
        assert!(rendered.ends_with("...[output truncated]"));
    }

    #[cfg(unix)]
    struct SourceUpdateFixture {
        root: PathBuf,
        repo: PathBuf,
        staged: PathBuf,
        command_log: PathBuf,
        config: SourceUpdateConfig,
        base_head: String,
    }

    #[cfg(unix)]
    impl SourceUpdateFixture {
        fn new(failing_cargo_command: Option<&str>) -> Self {
            use std::os::unix::fs::PermissionsExt;

            let root =
                std::env::temp_dir().join(format!("kiro-source-update-test-{}", Uuid::new_v4()));
            let repo = root.join("repo");
            let upstream = root.join("upstream");
            let tools = root.join("tools");
            let staging = root.join("staging");
            std::fs::create_dir_all(repo.join("admin-ui")).unwrap();
            std::fs::create_dir_all(&tools).unwrap();
            std::fs::create_dir_all(&staging).unwrap();

            git(&repo, &["init"]);
            git(&repo, &["symbolic-ref", "HEAD", "refs/heads/master"]);
            configure_git_identity(&repo);
            std::fs::write(repo.join("admin-ui/package.json"), "{}\n").unwrap();
            std::fs::write(
                repo.join("admin-ui/package-lock.json"),
                "{\"name\":\"fixture\",\"lockfileVersion\":3,\"packages\":{}}\n",
            )
            .unwrap();
            std::fs::write(repo.join("base.txt"), "base\n").unwrap();
            git(
                &repo,
                &[
                    "add",
                    "admin-ui/package.json",
                    "admin-ui/package-lock.json",
                    "base.txt",
                ],
            );
            git(&repo, &["commit", "-m", "base"]);
            let base_head = git(&repo, &["rev-parse", "HEAD"]);

            git(
                &root,
                &["clone", repo.to_str().unwrap(), upstream.to_str().unwrap()],
            );
            configure_git_identity(&upstream);
            std::fs::write(upstream.join("release.txt"), "release\n").unwrap();
            git(&upstream, &["add", "release.txt"]);
            git(&upstream, &["commit", "-m", "release"]);
            git(&upstream, &["tag", "v1.1.0"]);

            let command_log = root.join("commands.log");
            let npm_script = format!(
                "#!/bin/sh\nprintf '%s\\n' \"npm $*\" >> '{}'\nexit 0\n",
                command_log.display()
            );
            let cargo_failure = failing_cargo_command
                .map(|command| {
                    format!(
                        "if [ \"$1\" = \"{command}\" ]; then\n  echo forced failure >&2\n  exit 23\nfi\n"
                    )
                })
                .unwrap_or_default();
            let cargo_script = format!(
                "#!/bin/sh\nprintf '%s\\n' \"cargo $*\" >> '{}'\n{}if [ \"$1\" = \"build\" ] && [ \"$2\" = \"--release\" ]; then\n  mkdir -p \"$PWD/target/release\"\n  printf 'fake-binary\\n' > \"$PWD/target/release/kiro-rs\"\nfi\nexit 0\n",
                command_log.display(),
                cargo_failure
            );
            for (name, script) in [("npm", npm_script), ("cargo", cargo_script)] {
                let path = tools.join(name);
                std::fs::write(&path, script).unwrap();
                let mut permissions = std::fs::metadata(&path).unwrap().permissions();
                permissions.set_mode(0o755);
                std::fs::set_permissions(path, permissions).unwrap();
            }

            let inherited_path = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into());
            let config = SourceUpdateConfig {
                repo_path: repo.clone(),
                branch: "master".to_string(),
                upstream_git_url: upstream.to_string_lossy().into_owned(),
                build_path: format!("{}:{inherited_path}", tools.display()),
            };

            Self {
                root,
                repo,
                staged: staging.join("kiro-rs"),
                command_log,
                config,
                base_head,
            }
        }

        fn source_refs(&self) -> String {
            git(
                &self.repo,
                &[
                    "for-each-ref",
                    "--format=%(refname)",
                    "refs/kiro-source-update",
                ],
            )
        }

        fn head(&self) -> String {
            git(&self.repo, &["rev-parse", "HEAD"])
        }
    }

    #[cfg(unix)]
    impl Drop for SourceUpdateFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[cfg(unix)]
    fn configure_git_identity(repo: &Path) {
        git(repo, &["config", "user.name", "source-update-test"]);
        git(
            repo,
            &["config", "user.email", "source-update-test@localhost"],
        );
    }

    #[cfg(unix)]
    fn git(cwd: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .unwrap_or_else(|error| panic!("failed to run git {args:?}: {error}"));
        assert!(
            output.status.success(),
            "git {args:?} failed (status={}):\nstdout: {}\nstderr: {}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn source_prepare_and_promote_preserve_cas_and_cleanup_resources() {
        let fixture = SourceUpdateFixture::new(None);

        let prepared = prepare_release(&fixture.config, "1.1.0", &fixture.staged)
            .await
            .unwrap();

        assert_eq!(fixture.head(), fixture.base_head);
        assert!(!prepared.reused);
        assert!(fixture.staged.is_file());
        assert!(sidecar_path(&fixture.staged).is_file());
        assert_eq!(fixture.source_refs(), prepared.staged_ref);
        assert_eq!(
            std::fs::read_to_string(&fixture.command_log)
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            vec![
                "npm ci --no-audit --no-fund",
                "npm run build",
                "cargo check --locked",
                "cargo test --locked",
                "cargo build --release --locked",
            ]
        );

        promote_prepared(&fixture.config, &prepared, &fixture.staged)
            .await
            .unwrap();
        assert_eq!(fixture.head(), prepared.merged_commit);
        assert!(fixture.repo.join("release.txt").is_file());

        finalize_prepared(&fixture.config, &prepared, &fixture.staged).await;
        assert!(!fixture.staged.exists());
        assert!(!sidecar_path(&fixture.staged).exists());
        assert!(fixture.source_refs().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn source_prepare_build_failure_leaves_branch_and_artifacts_untouched() {
        let fixture = SourceUpdateFixture::new(Some("test"));

        let error = prepare_release(&fixture.config, "1.1.0", &fixture.staged)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("cargo test --locked"));
        assert_eq!(fixture.head(), fixture.base_head);
        assert!(!fixture.staged.exists());
        assert!(!sidecar_path(&fixture.staged).exists());
        assert!(fixture.source_refs().is_empty());
        let worktrees = git(&fixture.repo, &["worktree", "list", "--porcelain"]);
        assert_eq!(
            worktrees
                .lines()
                .filter(|line| line.starts_with("worktree "))
                .count(),
            1
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn source_promote_rejects_head_changed_after_prepare() {
        let fixture = SourceUpdateFixture::new(None);
        let prepared = prepare_release(&fixture.config, "1.1.0", &fixture.staged)
            .await
            .unwrap();

        std::fs::write(fixture.repo.join("local.txt"), "local change\n").unwrap();
        git(&fixture.repo, &["add", "local.txt"]);
        git(&fixture.repo, &["commit", "-m", "local change"]);
        let changed_head = fixture.head();

        let error = promote_prepared(&fixture.config, &prepared, &fixture.staged)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("CAS"));
        assert_eq!(fixture.head(), changed_head);
        assert_ne!(changed_head, prepared.merged_commit);

        finalize_prepared(&fixture.config, &prepared, &fixture.staged).await;
        assert!(fixture.source_refs().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn source_prepare_rejects_dirty_repository_before_fetching() {
        let fixture = SourceUpdateFixture::new(None);
        std::fs::write(fixture.repo.join("untracked.txt"), "dirty\n").unwrap();

        let error = prepare_release(&fixture.config, "1.1.0", &fixture.staged)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("未提交或未跟踪改动"));
        assert_eq!(fixture.head(), fixture.base_head);
        assert!(fixture.source_refs().is_empty());
        assert!(!fixture.command_log.exists());
    }
}
