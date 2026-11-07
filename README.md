# Simple PDF

在浏览器中整理、合并和导出 PDF 的画布工具。

[打开在线站点](https://pdf-page-workbench.cjx2805.chatgpt.site)

## 功能

- 导入 PDF、PNG、JPG 和 JPEG，使用素材文件夹整理文件。
- 在画布中拖动页面、嵌套集合、多选移动及管理叠放顺序。
- 通过 Start 和 Over 编排工作流，或导出整个画布。
- 预合成 PDF，统一页宽，设置文件大小上限、页码和水印。
- 保存及重新打开 `.pdfboard` 工程，设置自动保存间隔。
- 切换中文和英文界面。

## 本地运行

项目为静态 HTML、CSS 和 JavaScript，运行所需的 PDF 库已包含在 `dist/vendor`。

在项目根目录启动一个本地 HTTP 服务器。例如，已安装 Python 3 时可以运行：

```shell
python -m http.server 8000 --directory dist
```

然后在浏览器打开 `http://localhost:8000`。通过 HTTP 或 HTTPS 访问可以加载 JavaScript 模块及 PDF 预览 worker。

## 目录

- `dist/index.html` 为应用入口。
- `dist/board.js` 和 `dist/board.css` 负责画布交互及界面。
- `dist/project.js` 负责工程结构和序列化。
- `dist/pdf-output.js` 负责 PDF 合成与导出。
- `dist/vendor` 保存 PDF.js、pdf-lib、字体资源和相应许可证。

## 静态部署

将 `dist` 作为站点发布目录。工程持续保存功能需要浏览器支持文件系统访问，首次使用时由用户选择本机工程文件并授权。

## 第三方依赖

- PDF.js 及许可证位于 `dist/vendor/pdfjs-LICENSE`。
- pdf-lib 及许可证位于 `dist/vendor/pdf-lib-LICENSE.md`。
- CMap 与标准字体的许可证位于各自资源目录。

项目自身的许可证由仓库维护者决定。
