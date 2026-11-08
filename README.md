# Simple PDF

A browser-based canvas for organizing, merging, and exporting PDF pages.

[Launch Simple PDF](https://pdf-page-workbench.cjx2805.chatgpt.site)

## Features

- Import PDF, PNG, JPG, and JPEG files and organize them into asset folders.
- Arrange pages on a canvas with nested collections, multiple selection, group movement, and stacking controls.
- Build export workflows with Start and Over nodes, or export the entire canvas.
- Preview the generated PDF and configure a uniform page width, file size limit, page numbers, and watermarks.
- Save and reopen `.pdfboard` projects and configure the autosave interval.
- Switch between English and Chinese interfaces.

## Run Locally

The application uses static HTML, CSS, and JavaScript. The required PDF libraries are bundled in `dist/vendor`.

Start a local HTTP server from the repository root. For example, with Python 3 installed:

```shell
python -m http.server 8000 --directory dist
```

Then open `http://localhost:8000` in your browser. Serve the application over HTTP or HTTPS so that JavaScript modules and the PDF preview worker can load.

## Project Structure

- `dist/index.html` — application entry point.
- `dist/board.js` and `dist/board.css` — canvas interactions and interface.
- `dist/project.js` — project structure and serialization.
- `dist/pdf-output.js` — PDF composition and export.
- `dist/vendor` — PDF.js, pdf-lib, font resources, and their licenses.

## Static Deployment

Use `dist` as the publish directory. Saving updates to the same local project file requires a browser that supports the File System Access API. Users must select a local project file and grant access when first saving.

## Third-Party Dependencies

- PDF.js — license in `dist/vendor/pdfjs-LICENSE`.
- pdf-lib — license in `dist/vendor/pdf-lib-LICENSE.md`.
- CMap and standard font licenses are included in their respective resource directories.

The license for the application itself is to be determined by the repository maintainer.
