# 添加到桌面：实现与验收记录

使用一个App级安装组件，Teleport在认证页面与管理页顶栏之间移动，保留待安装事件。原生安装仅响应点击；其他电脑、安卓、iPhone/iPad、Mac Safari及内置浏览器使用手动指引。独立窗口/appinstalled隐藏，accepted不冒充完成；打印隐藏安装控件。

public中的manifest及180/192/512 PNG沿用原紫色视频图标；HTML采用BASE_URL链接适配深路由。保留原栈、主题、认证、接口及数据，不增加运行依赖或Service Worker。

- [x] 先执行失败回归，再实现安装控制器、组件及清单；6项安装行为测试通过。
- [x] `npm run check`：lint、架构、256项测试通过，Windows跳过1项POSIX权限断言，Vite构建通过。
- [x] `npm run test:ui`：6项既有合成浏览器UI场景通过。
- [x] Chrome持久测试配置：桌面、390px iPhone和320px安卓模拟的manifest解析及安装资格无错误，指引/关闭焦点/布局通过、手机目标44px；另以320px合成登录验证Teleport保留登录前的原生安装事件。
- [x] 交叉只读审查、git diff --check通过；锁文件无变更。

未读取私人配置、未运行真实后台连接；浏览器只用静态产物/合成数据及本机假接口。实际iOS/安卓/macOS安装及容器运行未验证。保持当前分支，未提交、推送或部署。
