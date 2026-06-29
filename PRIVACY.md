# 隐私与用户数据说明

Mineradio 是本地桌面应用。项目不应把用户登录状态、Cookie、播放历史、搜索历史、自定义封面、自定义歌词或本地缓存提交到 GitHub。

## 本地数据

应用可能在本机保存以下数据：

- Spotify Client ID、访问令牌和刷新令牌
- 搜索历史
- 自定义专辑封面
- 自定义歌词
- 歌词布局与视觉控制设置
- 本地节奏分析缓存
- 更新安装包下载缓存

这些数据用于本地体验，不属于开源仓库内容。

## 不应上传的内容

以下内容不应提交到 GitHub：

- `.spotify-auth.json`
- `updates/`
- `node_modules/`
- Electron 打包产物
- 用户上传的本地音乐文件
- 用户账号信息、Token 和授权状态

## Spotify

Spotify Client ID、访问令牌和刷新令牌仅保存在本机用户数据目录的 `.spotify-auth.json`。断开 Spotify 会清除访问令牌与刷新令牌；不会下载、缓存或分析 Spotify 音频。用户应遵守 Spotify 的平台条款。
