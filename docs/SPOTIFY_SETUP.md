# Spotify Connect 设置

Mineradio 的 Spotify 支持采用“Connect 控制器”模式：可以登录、搜索、读取喜欢的音乐、显示封面与进度，并控制当前 Spotify 设备。Spotify 音频不会进入 Mineradio 的节拍分析器，Spotify 曲目使用环境视觉。

## 1. 创建 Spotify Developer 应用

1. 打开 [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)。
2. 创建一个应用，记录 **Client ID**。Mineradio 使用 OAuth Authorization Code with PKCE，不需要也不会保存 Client Secret。
3. 在应用的 Redirect URIs 中加入：

   http://127.0.0.1/api/spotify/callback

Spotify 官方允许 loopback IP 省略端口；Mineradio 在实际授权请求中会使用当前本地服务端口。不要改成 localhost。

## 2. 在 Mineradio 中连接

1. 启动 Mineradio。
2. 点击右上角 **SP**，或在搜索来源中选择 **SP**。
3. 粘贴 Client ID 并保存。
4. 点击“连接 Spotify”，在系统浏览器完成授权。
5. 返回 Mineradio。右上角 SP 出现绿色状态点即表示连接成功。

## 3. 播放

- 先在 Spotify 桌面端、手机或其它 Spotify Connect 设备中启动一次播放，确保存在活跃设备。
- 在 Mineradio 的 SP 搜索结果中选择歌曲，播放请求会发送到当前活跃设备。
- 播放、暂停和拖动进度通常要求 Spotify Premium。
- “喜欢的音乐”按钮会读取当前 Spotify 账号保存的曲目。

## 数据与限制

- Client ID、访问令牌和刷新令牌只保存在本机用户数据目录的 .spotify-auth.json 中。
- 点击“断开”会删除 Spotify 访问令牌和刷新令牌，并保留 Client ID 便于以后重新授权。
- Spotify 曲目不会被下载、代理、离线分析或混入其它音源。
- Spotify 当前的开发者政策禁止将其录音与视觉媒体同步，因此 Spotify 模式只使用不读取音频的环境视觉。网易云、QQ 和本地文件的现有视觉逻辑不受影响。
