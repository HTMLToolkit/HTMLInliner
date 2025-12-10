# HTMLInliner

Standalone utility for:
- loading the full contents of a static web project
- visualising every dependency (HTML → CSS → JS → assets)
- exporting a single-file HTML document with CSS, JS, fonts, images, audio/video, and other `url()` assets inlined as data URIs.

## Features
- Visual dependency graph powered by D3 with presence/external/missing status colouring.
- Recursive CSS processor that resolves relative `@import` chains and `url()` assets.
- JS import/require scanner that follows local `import`, `require`, and dynamic `import()` statements.
- Media encoder that converts any referenced local `img`, `video`, `audio`, or `<source>` asset to a base64 data URI.
- Activity log with detailed success/error reporting for every step.

## Usage
1. Open `index.html` in a modern browser (Chrome, Edge, Firefox, Safari latest). No build step required.
2. Drag-select every file from your project folder (or use the file picker) and drop them into the **Project bundle** input.
3. The dependency graph renders immediately. Missing files show in red so you can fix gaps before inlining.
4. Click **Download Inlined HTML** to generate a single HTML file. The filename mirrors your original HTML with `.inlined.html` appended.

### Tips
- Include the HTML entry point and every file it references (CSS, JS, images, fonts, audio/video, JSON, etc.).
- Remote URLs remain external; failures to fetch remote assets are logged.
- Circular CSS imports are detected and skipped with a warning.
- For deeply nested relative paths, keep the original directory structure when selecting files so the resolver can match them.

## Architecture
- `styles.css` — layout/theme based on a dark glassmorphism treatment.
- `app.js` — modular client-side code containing:
	- `Logger`, `FileStore`, `CssProcessor`, `JsAnalyzer`, `DependencyVisualizer`, `HtmlInliner`, and `UIController` classes.
	- Shared helpers for normalising paths, resolving relatives, debounced resize handling, fetch-with-timeout, and file → data-URL conversion.

## Development
- No build tooling is required; edit the three repo files and refresh the browser.
- D3 v7 is pulled from the CDN; update the script tag in `index.html` if you need a different version.

## License
See `LICENSE` for details.
