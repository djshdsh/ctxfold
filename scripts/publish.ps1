# 把本仓库推到 GitHub：建仓库（可选）+ 推 main + 推 tag。
# 用法（Token 方式，推荐）：
#   .\scripts\publish.ps1 -Token <PAT> -Repo 用户名/ctxfold -Private
# 用法（SSH 私钥方式）：
#   .\scripts\publish.ps1 -SshKeyPath $HOME\.ssh\id_ed25519 -Repo 用户名/ctxfold
# 用法（只看会做什么，不碰网络）：
#   .\scripts\publish.ps1 -Repo 用户名/ctxfold -DryRun
param(
  [string]$Token,
  [string]$SshKeyPath,
  [Parameter(Mandatory = $true)][string]$Repo,
  [switch]$Private,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
$root = (Split-Path -Parent $PSScriptRoot)
Set-Location $root

function Say($m) { Write-Host $m }
function Die($m) { Write-Host "错误：$m" -ForegroundColor Red; exit 1 }

if ($Repo -notmatch '^[^/]+/[^/]+$') { Die "-Repo 要写成 用户名/仓库名" }
$owner, $name = $Repo -split '/'

Say "仓库目录 : $root"
Say "目标     : https://github.com/$Repo  ($(if($Private){'私有'}else{'公开'}))"

# ---- 本地检查 ----
if (-not (Test-Path (Join-Path $root '.git'))) { Die "这里不是 git 仓库" }
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
Say "当前分支 : $branch"
$commits = [int](git rev-list --count HEAD)
Say "提交数   : $commits"
$tags = @(git tag --list)
Say "本地 tag : $(if($tags.Count){$tags -join ', '}else{'(无)'})"
if ($commits -lt 1) { Die "还没有提交" }

$dirty = (git status --porcelain)
if ($dirty) { Say "提示：工作区有未提交改动，这些不会上传。" }

if ($DryRun) {
  Say ""
  Say "DryRun：以下会被执行"
  Say "  1. 检查 GitHub 账号与仓库是否存在（需要 token/ssh）"
  Say "  2. 不存在则创建仓库 $Repo"
  Say "  3. git remote add origin <url>；git push -u origin $branch"
  Say "  4. git push origin --tags"
  Say "  5. 把 origin 的地址还原成不含凭据的形式"
  exit 0
}

if (-not $Token -and -not $SshKeyPath) { Die "要么给 -Token，要么给 -SshKeyPath" }

# ---- 账号 & 仓库 ----
if ($Token) {
  $headers = @{
    Authorization          = "Bearer $Token"
    Accept                 = "application/vnd.github+json"
    "User-Agent"           = "ctxfold-publish"
    "X-GitHub-Api-Version" = "2022-11-28"
  }
  try {
    $me = Invoke-RestMethod -Uri "https://api.github.com/user" -Headers $headers -Method Get
  } catch {
    Die "token 无效或没有权限：$($_.Exception.Message)"
  }
  Say "登录为   : $($me.login)"
  if ($owner -ne $me.login) {
    Say "警告：仓库所有者 $owner 与登录账号 $($me.login) 不一致（组织仓库需要相应权限）"
  }

  $exists = $true
  try {
    [void](Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo" -Headers $headers -Method Get)
  } catch {
    if ("$($_.Exception.Response.StatusCode.value__)" -eq "404") { $exists = $false }
    else { Die "查询仓库失败：$($_.Exception.Message)" }
  }

  if (-not $exists) {
    Say "仓库不存在，创建中…"
    $body = @{
      name        = $name
      private     = [bool]$Private
      description = "ctxfold — Pi Agent 提示词控制台：分层注入、一键清洗、原生桌面壳"
      has_issues  = $true
      has_wiki    = $false
    } | ConvertTo-Json
    try {
      [void](Invoke-RestMethod -Uri "https://api.github.com/user/repos" -Headers $headers -Method Post -Body $body -ContentType "application/json")
      Say "已创建 https://github.com/$Repo"
    } catch {
      Die "创建仓库失败：$($_.Exception.Message)"
    }
  } else {
    Say "仓库已存在，直接推送"
  }

  $pushUrl = "https://x-access-token:$Token@github.com/$Repo.git"
  $cleanUrl = "https://github.com/$Repo.git"
} else {
  if (-not (Test-Path $SshKeyPath)) { Die "找不到私钥：$SshKeyPath" }
  Say "使用 SSH 私钥 : $SshKeyPath"
  $git = (Get-Command git).Source
  $ssh = (Get-Command ssh).Source
  git config core.sshCommand "`"$ssh`" -i `"$SshKeyPath`" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
  $pushUrl = "git@github.com:$Repo.git"
  $cleanUrl = $pushUrl
}

# ---- 推送 ----
try {
  $remotes = @(git remote)
  if ($remotes -contains 'origin') { git remote set-url origin $pushUrl } else { git remote add origin $pushUrl }

  Say "推送 $branch …"
  git push -u origin $branch
  if ($LASTEXITCODE -ne 0) { Die "push 失败（exit $LASTEXITCODE）" }

  if ($tags.Count) {
    Say "推送 tag：$($tags -join ', ')"
    git push origin --tags
    if ($LASTEXITCODE -ne 0) { Say "tag 推送失败（可能已存在），不影响代码" }
  }
} finally {
  # 无论如何都别把凭据留在 .git/config 里
  if ($Token) { try { git remote set-url origin $cleanUrl } catch { } }
}

Say ""
Say "完成：https://github.com/$Repo"
Say "Actions：https://github.com/$Repo/actions"
Say "Releases：https://github.com/$Repo/releases"
Say ""
Say "如果用的是 token：现在就可以去 GitHub 设置里把它删掉了（Settings → Developer settings → Tokens）。"
