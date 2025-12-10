const DEFAULT_TIMEOUT = 12000;
const DATA_PREFIX = 'data:';
const HTTP_PATTERN = /^(?:https?:)?\/\//i;

const escapeRegExp = (value = '') => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isRemote = (value = '') => HTTP_PATTERN.test(value);
const isDataUri = (value = '') => value.startsWith(DATA_PREFIX);
const isLocalPath = (value = '') => Boolean(value) && !isRemote(value) && !isDataUri(value);

function normalizePath(path = '') {
    return path.replace(/^(\.\/|\/|\\)+/, '').replace(/\\+/g, '/');
}

function resolveRelativePath(fromPath = '', targetPath = '') {
    if (!targetPath) {
        return '';
    }
    if (isRemote(targetPath) || isDataUri(targetPath)) {
        return targetPath;
    }

    const cleanTarget = targetPath.split(/[?#]/)[0];
    if (cleanTarget.startsWith('/')) {
        return normalizePath(cleanTarget);
    }

    let sanitizedTarget = cleanTarget;
    while (sanitizedTarget.startsWith('./')) {
        sanitizedTarget = sanitizedTarget.slice(2);
    }

    const baseNormalized = normalizePath(fromPath);
    const baseSegments = baseNormalized ? baseNormalized.split('/').filter(Boolean) : [];
    if (baseSegments.length && !baseNormalized.endsWith('/')) {
        baseSegments.pop();
    }

    const relSegments = sanitizedTarget.split('/');
    for (const segment of relSegments) {
        if (!segment || segment === '.') {
            continue;
        }
        if (segment === '..') {
            if (baseSegments.length) {
                baseSegments.pop();
            }
        } else {
            baseSegments.push(segment);
        }
    }

    return baseSegments.join('/');
}

function debounce(fn, wait = 150) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(null, args), wait);
    };
}

async function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Unable to encode file as data URL'));
        reader.readAsDataURL(file);
    });
}

async function fetchWithTimeout(url, timeout = DEFAULT_TIMEOUT) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return await response.text();
    } finally {
        clearTimeout(timer);
    }
}

class Logger {
    constructor(node) {
        this.node = node;
    }

    log(message, type = 'info') {
        if (!this.node) {
            return;
        }
        const entry = document.createElement('div');
        entry.className = type === 'info' ? '' : type;
        entry.textContent = message;
        this.node.appendChild(entry);
        this.node.scrollTop = this.node.scrollHeight;
    }

    info(message) { this.log(message, 'info'); }
    success(message) { this.log(message, 'success'); }
    warn(message) { this.log(message, 'warning'); }
    error(message) { this.log(message, 'error'); }

    clear() {
        if (this.node) {
            this.node.innerHTML = '';
        }
    }
}

class FileStore {
    constructor() {
        this.files = new Map();
    }

    reset() {
        this.files.clear();
    }

    ingest(fileList) {
        this.reset();
        Array.from(fileList || []).forEach(file => {
            const key = normalizePath(file.webkitRelativePath || file.name);
            if (key) {
                this.files.set(key, file);
            }
        });
        return this.files.size;
    }

    has(path) {
        return this.files.has(normalizePath(path));
    }

    get(path) {
        return this.files.get(normalizePath(path));
    }

    async text(path) {
        const file = this.get(path);
        if (!file) {
            throw new Error(`Missing file: ${path}`);
        }
        return file.text();
    }

    keys() {
        return Array.from(this.files.keys());
    }

    listByExtension(ext) {
        const normalized = ext.toLowerCase();
        return this.keys().filter(name => name.toLowerCase().endsWith(normalized));
    }
}

class CssProcessor {
    static extractImports(cssText = '') {
        const imports = [];
        const importPattern = /@import\s+(?:url\s*\(\s*)?['"]?([^'"\);\s]+)['"]?\s*(?:\)\s*)?(?:[^;]*)?;/gi;
        let match;
        while ((match = importPattern.exec(cssText)) !== null) {
            imports.push(match[1]);
        }
        return imports;
    }

    static extractUrls(cssText = '') {
        const urls = [];
        const urlPattern = /url\s*\(\s*['"]?([^'"\)]+)['"]?\s*\)/gi;
        let match;
        while ((match = urlPattern.exec(cssText)) !== null) {
            urls.push(match[1]);
        }
        return urls;
    }

    static async inlineImports(cssText, fileStore, logger, currentPath, visited = new Set()) {
        if (!cssText || !isLocalPath(currentPath)) {
            return cssText;
        }
        let output = cssText;
        const imports = this.extractImports(cssText);
        for (const importUrl of imports) {
            const resolvedPath = resolveRelativePath(currentPath, importUrl);
            if (!isLocalPath(resolvedPath)) {
                continue;
            }
            const normalized = normalizePath(resolvedPath);
            if (visited.has(normalized)) {
                logger.warn(`Circular CSS import skipped: ${importUrl}`);
                continue;
            }
            const file = fileStore.get(normalized);
            if (!file) {
                logger.error(`CSS import missing: ${importUrl}`);
                continue;
            }
            try {
                const importedCss = await file.text();
                const nextVisited = new Set(visited);
                nextVisited.add(normalized);
                const processed = await this.inlineImports(importedCss, fileStore, logger, normalized, nextVisited);
                const withAssets = await this.inlineUrls(processed, fileStore, logger, normalized);
                const importRegex = new RegExp(`@import\\s+(?:url\\s*\\(\\s*)?['"]?${escapeRegExp(importUrl)}['"]?\\s*(?:\\)\\s*)?(?:[^;]*)?;`, 'gi');
                output = output.replace(importRegex, `/* Imported from ${importUrl} */\n${withAssets}\n`);
                logger.success(`Inlined CSS import: ${importUrl}`);
            } catch (error) {
                logger.error(`Unable to inline CSS import ${importUrl}: ${error.message}`);
            }
        }
        return output;
    }

    static async inlineUrls(cssText, fileStore, logger, currentPath) {
        if (!cssText || !isLocalPath(currentPath)) {
            return cssText;
        }
        let output = cssText;
        const urls = this.extractUrls(cssText);
        for (const assetUrl of urls) {
            const resolvedPath = resolveRelativePath(currentPath, assetUrl);
            if (!isLocalPath(resolvedPath)) {
                continue;
            }
            const file = fileStore.get(resolvedPath);
            if (!file) {
                logger.warn(`CSS asset missing: ${assetUrl}`);
                continue;
            }
            try {
                const base64 = await fileToDataUrl(file);
                const urlRegex = new RegExp(`url\\s*\\(\\s*['"]?${escapeRegExp(assetUrl)}['"]?\\s*\\)`, 'gi');
                output = output.replace(urlRegex, `url("${base64}")`);
                logger.success(`Inlined CSS asset: ${assetUrl}`);
            } catch (error) {
                logger.error(`Unable to inline CSS asset ${assetUrl}: ${error.message}`);
            }
        }
        return output;
    }
}

class JsAnalyzer {
    static extractImports(jsText = '') {
        const imports = new Set();
        const esModulePattern = /import\s+(?:[^'"\n]*?from\s+)?['"]([^'"]+)['"]/gi;
        const requirePattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/gi;
        const dynamicImportPattern = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/gi;
        for (const pattern of [esModulePattern, requirePattern, dynamicImportPattern]) {
            let match;
            while ((match = pattern.exec(jsText)) !== null) {
                imports.add(match[1]);
            }
        }
        return Array.from(imports);
    }
}

class DependencyVisualizer {
    constructor(svgElement, logger) {
        this.svgElement = svgElement;
        this.logger = logger;
    }

    async render({ doc, fileStore, htmlFileName }) {
        if (!doc || !htmlFileName) {
            return;
        }
        const d3Ref = window.d3;
        if (!d3Ref) {
            this.logger.error('D3.js is required to draw the dependency graph');
            return;
        }

        const nodes = new Map();
        const links = [];
        const processed = new Set();

        const addNode = (id, type, status, label) => {
            if (!id) {
                return;
            }
            if (!nodes.has(id)) {
                nodes.set(id, { id, type, status, label: label || id });
            } else {
                const existing = nodes.get(id);
                if (existing.status === 'missing' && status === 'present') {
                    existing.status = status;
                }
                if (!existing.label && label) {
                    existing.label = label;
                }
            }
        };

        const registerLink = (source, target) => {
            if (source && target) {
                links.push({ source, target });
            }
        };

        const statusForPath = path => {
            if (!path) {
                return 'missing';
            }
            if (!isLocalPath(path)) {
                return isRemote(path) || isDataUri(path) ? 'external' : 'missing';
            }
            return fileStore.has(path) ? 'present' : 'missing';
        };

        const addDependenciesRecursively = async (parentId, parentType, basePath) => {
            const key = `${parentType}:${parentId}`;
            if (processed.has(key)) {
                return;
            }
            processed.add(key);

            if (parentType === 'html') {
                const cssLinks = Array.from(doc.querySelectorAll('link[rel="stylesheet"]'));
                for (const link of cssLinks) {
                    const href = link.getAttribute('href');
                    if (!href) continue;
                    const resolved = resolveRelativePath(basePath, href) || href;
                    const status = statusForPath(resolved);
                    addNode(resolved, 'css', status, href);
                    registerLink(parentId, resolved);
                    if (status === 'present') {
                        await addDependenciesRecursively(resolved, 'css', resolved);
                    }
                }

                const scripts = Array.from(doc.querySelectorAll('script[src]'));
                for (const script of scripts) {
                    const src = script.getAttribute('src');
                    if (!src) continue;
                    const resolved = resolveRelativePath(basePath, src) || src;
                    const status = statusForPath(resolved);
                    addNode(resolved, 'js', status, src);
                    registerLink(parentId, resolved);
                    if (status === 'present') {
                        await addDependenciesRecursively(resolved, 'js', resolved);
                    }
                }

                const images = Array.from(doc.querySelectorAll('img[src]'));
                for (const img of images) {
                    const src = img.getAttribute('src');
                    if (!src) continue;
                    const resolved = resolveRelativePath(basePath, src) || src;
                    const status = statusForPath(resolved);
                    addNode(resolved, 'img', status, src);
                    registerLink(parentId, resolved);
                }

                const mediaNodes = Array.from(doc.querySelectorAll('audio[src], video[src], source[src]'));
                for (const media of mediaNodes) {
                    const src = media.getAttribute('src');
                    if (!src) continue;
                    const resolved = resolveRelativePath(basePath, src) || src;
                    const status = statusForPath(resolved);
                    addNode(resolved, 'media', status, src);
                    registerLink(parentId, resolved);
                }
            }

            if (parentType === 'css') {
                if (!fileStore.has(parentId)) {
                    return;
                }
                try {
                    const cssContent = await fileStore.text(parentId);
                    for (const importUrl of CssProcessor.extractImports(cssContent)) {
                        const resolved = resolveRelativePath(basePath, importUrl) || importUrl;
                        const status = statusForPath(resolved);
                        addNode(resolved, 'css', status, importUrl);
                        registerLink(parentId, resolved);
                        if (status === 'present') {
                            await addDependenciesRecursively(resolved, 'css', resolved);
                        }
                    }
                    for (const assetUrl of CssProcessor.extractUrls(cssContent)) {
                        const resolved = resolveRelativePath(basePath, assetUrl) || assetUrl;
                        const status = statusForPath(resolved);
                        addNode(resolved, 'asset', status, assetUrl);
                        registerLink(parentId, resolved);
                    }
                } catch (error) {
                    this.logger.warn(`Unable to parse CSS file ${parentId}: ${error.message}`);
                }
            }

            if (parentType === 'js') {
                if (!fileStore.has(parentId)) {
                    return;
                }
                try {
                    const jsContent = await fileStore.text(parentId);
                    for (const importUrl of JsAnalyzer.extractImports(jsContent)) {
                        const candidates = this.resolveJsCandidates(importUrl, basePath);
                        let found = false;
                        for (const candidate of candidates) {
                            if (isLocalPath(candidate) && fileStore.has(candidate)) {
                                addNode(candidate, 'js', 'present', importUrl);
                                registerLink(parentId, candidate);
                                await addDependenciesRecursively(candidate, 'js', candidate);
                                found = true;
                                break;
                            }
                        }
                        if (!found) {
                            const status = statusForPath(candidates[0] || importUrl);
                            addNode(candidates[0] || importUrl, 'js', status, importUrl);
                            registerLink(parentId, candidates[0] || importUrl);
                        }
                    }
                } catch (error) {
                    this.logger.warn(`Unable to parse JS file ${parentId}: ${error.message}`);
                }
            }
        };

        addNode(htmlFileName, 'html', 'present', htmlFileName);
        await addDependenciesRecursively(htmlFileName, 'html', htmlFileName);

        for (const name of fileStore.keys()) {
            if (name.endsWith('.css') && !nodes.has(name)) {
                addNode(name, 'css', 'present', name);
                await addDependenciesRecursively(name, 'css', name);
            }
            if (name.endsWith('.js') && !nodes.has(name)) {
                addNode(name, 'js', 'present', name);
                await addDependenciesRecursively(name, 'js', name);
            }
        }

        const nodeData = Array.from(nodes.values());
        const svg = d3Ref.select(this.svgElement);
        svg.selectAll('*').remove();

        const width = this.svgElement.clientWidth || this.svgElement.parentElement.clientWidth || 600;
        const height = this.svgElement.clientHeight || this.svgElement.parentElement.clientHeight || 600;

        const simulation = d3Ref.forceSimulation(nodeData)
            .force('link', d3Ref.forceLink(links).id(d => d.id).distance(120))
            .force('charge', d3Ref.forceManyBody().strength(-400))
            .force('center', d3Ref.forceCenter(width / 2, height / 2));

        const link = svg.append('g')
            .attr('stroke-width', 1.5)
            .selectAll('line')
            .data(links)
            .enter()
            .append('line')
            .attr('class', 'link');

        const node = svg.append('g')
            .selectAll('g')
            .data(nodeData)
            .enter()
            .append('g')
            .attr('class', 'node');

        node.append('circle')
            .attr('r', d => d.type === 'html' ? 20 : 14)
            .attr('fill', d => this.colorForNode(d))
            .attr('stroke', d => d.status === 'missing' ? '#dc2626' : '#020617')
            .attr('stroke-width', d => d.status === 'missing' ? 3 : 2);

        node.append('text')
            .attr('dx', 18)
            .attr('dy', 4)
            .attr('fill', d => d.status === 'missing' ? '#f87171' : '#e2e8f0')
            .text(d => this.abbreviate(d.label || d.id));

        node.append('title').text(d => `${d.label || d.id} (${d.type}, ${d.status})`);

        simulation.on('tick', () => {
            link
                .attr('x1', d => d.source.x)
                .attr('y1', d => d.source.y)
                .attr('x2', d => d.target.x)
                .attr('y2', d => d.target.y);

            node.attr('transform', d => `translate(${d.x}, ${d.y})`);
        });

        node.call(d3Ref.drag()
            .on('start', (event, d) => {
                if (!event.active) simulation.alphaTarget(0.3).restart();
                d.fx = d.x;
                d.fy = d.y;
            })
            .on('drag', (event, d) => {
                d.fx = event.x;
                d.fy = event.y;
            })
            .on('end', (event, d) => {
                if (!event.active) simulation.alphaTarget(0);
                d.fx = null;
                d.fy = null;
            }));

        const stats = nodeData.reduce((acc, entry) => {
            acc[entry.status] = (acc[entry.status] || 0) + 1;
            return acc;
        }, {});
        this.logger.info(`Dependencies — present: ${stats.present || 0}, missing: ${stats.missing || 0}, external: ${stats.external || 0}`);
    }

    resolveJsCandidates(importUrl, basePath) {
        if (!importUrl) {
            return [];
        }
        if (!importUrl.startsWith('.') && !importUrl.startsWith('/')) {
            return [importUrl];
        }
        const resolved = resolveRelativePath(basePath, importUrl);
        if (!resolved) {
            return [importUrl];
        }
        return [resolved, `${resolved}.js`, `${resolved}/index.js`];
    }

    abbreviate(id = '') {
        const name = id.split('/').pop() || id;
        return name.length > 18 ? `${name.slice(0, 15)}...` : name;
    }

    colorForNode(node) {
        if (node.status === 'missing') return '#f87171';
        if (node.status === 'external') return '#a855f7';
        switch (node.type) {
            case 'html': return '#38bdf8';
            case 'css': return '#34d399';
            case 'js': return '#fbbf24';
            case 'img': return '#2dd4bf';
            case 'media': return '#fde68a';
            case 'asset': return '#f472b6';
            default: return '#94a3b8';
        }
    }
}

class HtmlInliner {
    constructor(fileStore, logger, htmlFilePath) {
        this.fileStore = fileStore;
        this.logger = logger;
        this.htmlFilePath = htmlFilePath;
    }

    setHtmlPath(path) {
        this.htmlFilePath = path;
    }

    async inline(doc) {
        if (!this.htmlFilePath) {
            throw new Error('HTML path missing');
        }
        const clone = doc.cloneNode(true);
        await this.inlineCss(clone);
        await this.inlineJs(clone);
        await this.inlineMedia(clone);
        this.logger.success('All inline steps finished');
        return '<!DOCTYPE html>\n' + clone.documentElement.outerHTML;
    }

    async inlineCss(doc) {
        const links = Array.from(doc.querySelectorAll('link[rel="stylesheet"]'));
        for (const link of links) {
            const href = link.getAttribute('href');
            if (!href) continue;
            if (isDataUri(href)) {
                this.logger.info('CSS link already inlined via data URI');
                continue;
            }
            const resolvedPath = resolveRelativePath(this.htmlFilePath, href) || href;
            const cssText = await this.loadTextAsset(resolvedPath, 'CSS');
            if (!cssText) continue;
            const withImports = await CssProcessor.inlineImports(cssText, this.fileStore, this.logger, resolvedPath);
            const fullyInlined = await CssProcessor.inlineUrls(withImports, this.fileStore, this.logger, resolvedPath);
            const styleEl = doc.createElement('style');
            styleEl.textContent = fullyInlined;
            const media = link.getAttribute('media');
            if (media) {
                styleEl.setAttribute('media', media);
            }
            link.replaceWith(styleEl);
        }
    }

    async inlineJs(doc) {
        const scripts = Array.from(doc.querySelectorAll('script[src]'));
        for (const script of scripts) {
            const src = script.getAttribute('src');
            if (!src) continue;
            if (isDataUri(src)) {
                this.logger.info('Script already embedded via data URI');
                continue;
            }
            const resolvedPath = resolveRelativePath(this.htmlFilePath, src) || src;
            const jsText = await this.loadTextAsset(resolvedPath, 'JS');
            if (!jsText) continue;
            const inlineScript = doc.createElement('script');
            inlineScript.textContent = jsText;
            for (const attr of script.attributes) {
                if (attr.name !== 'src') {
                    inlineScript.setAttribute(attr.name, attr.value);
                }
            }
            script.replaceWith(inlineScript);
        }
    }

    async inlineMedia(doc) {
        const mediaTags = Array.from(doc.querySelectorAll('img[src], audio[src], video[src], source[src]'));
        for (const tag of mediaTags) {
            const src = tag.getAttribute('src');
            if (!src) {
                continue;
            }
            const resolvedPath = resolveRelativePath(this.htmlFilePath, src) || src;
            if (!isLocalPath(resolvedPath)) {
                continue;
            }
            const file = this.fileStore.get(resolvedPath);
            if (!file) {
                this.logger.warn(`Media file missing: ${src}`);
                continue;
            }
            try {
                const base64 = await fileToDataUrl(file);
                tag.setAttribute('src', base64);
                this.logger.success(`Inlined media asset: ${src}`);
            } catch (error) {
                this.logger.error(`Unable to inline media ${src}: ${error.message}`);
            }
        }
    }

    async loadTextAsset(path, label) {
        try {
            if (isRemote(path)) {
                const text = await fetchWithTimeout(path);
                this.logger.success(`Fetched remote ${label}: ${path}`);
                return text;
            }
            if (!this.fileStore.has(path)) {
                this.logger.error(`${label} file missing: ${path}`);
                return '';
            }
            const text = await this.fileStore.text(path);
            this.logger.success(`Loaded local ${label}: ${path}`);
            return text;
        } catch (error) {
            this.logger.error(`Unable to load ${label} ${path}: ${error.message}`);
            return '';
        }
    }
}

class UIController {
    constructor() {
        this.fileInput = document.getElementById('files');
        this.downloadBtn = document.getElementById('downloadBtn');
        this.logNode = document.getElementById('log');
        this.svgNode = document.getElementById('svg');

        this.logger = new Logger(this.logNode);
        this.fileStore = new FileStore();
        this.visualizer = new DependencyVisualizer(this.svgNode, this.logger);
        this.inliner = new HtmlInliner(this.fileStore, this.logger, '');

        this.doc = null;
        this.htmlFileName = '';

        this.resizeHandler = debounce(() => this.refreshGraph(), 200);

        this.bindEvents();
    }

    bindEvents() {
        this.fileInput.addEventListener('change', event => {
            this.handleFiles(event).catch(error => this.logger.error(error.message));
        });
        this.downloadBtn.addEventListener('click', () => {
            this.handleDownload().catch(error => this.logger.error(error.message));
        });
        window.addEventListener('resize', this.resizeHandler);
    }

    async handleFiles(event) {
        const fileList = event.target.files;
        this.logger.clear();
        this.downloadBtn.disabled = true;
        const total = this.fileStore.ingest(fileList);
        if (!total) {
            this.logger.error('No files selected');
            this.doc = null;
            this.htmlFileName = '';
            return;
        }
        this.logger.info(`Loaded ${total} file(s)`);
        const htmlFiles = this.fileStore.listByExtension('.html');
        if (!htmlFiles.length) {
            this.logger.error('Please include at least one HTML file');
            this.doc = null;
            this.htmlFileName = '';
            return;
        }
        if (htmlFiles.length > 1) {
            this.logger.warn(`Multiple HTML files detected, defaulting to ${htmlFiles[0]}`);
        }
        this.htmlFileName = htmlFiles[0];
        this.inliner.setHtmlPath(this.htmlFileName);
        const htmlText = await this.fileStore.text(this.htmlFileName);
        const parsed = new DOMParser().parseFromString(htmlText, 'text/html');
        const parserError = parsed.querySelector('parsererror');
        if (parserError) {
            this.logger.warn('HTML parsing reported potential syntax issues');
        }
        this.doc = parsed;
        this.logger.success(`Loaded HTML file: ${this.htmlFileName}`);
        this.downloadBtn.disabled = false;
        await this.refreshGraph();
    }

    async handleDownload() {
        if (!this.doc || !this.htmlFileName) {
            this.logger.error('Load an HTML file before inlining');
            return;
        }
        this.toggleDownloadState(true);
        this.logger.info('Starting inline process');
        try {
            const inlined = await this.inliner.inline(this.doc);
            const outputName = this.buildOutputName(this.htmlFileName);
            this.triggerDownload(inlined, outputName);
            this.logger.success(`Download ready: ${outputName}`);
        } catch (error) {
            this.logger.error(`Inline process failed: ${error.message}`);
        } finally {
            this.toggleDownloadState(false);
        }
    }

    async refreshGraph() {
        if (!this.doc || !this.htmlFileName) {
            return;
        }
        await this.visualizer.render({
            doc: this.doc,
            fileStore: this.fileStore,
            htmlFileName: this.htmlFileName
        });
    }

    toggleDownloadState(isBusy) {
        this.downloadBtn.disabled = isBusy;
        this.downloadBtn.textContent = isBusy ? 'Inlining...' : 'Download Inlined HTML';
    }

    buildOutputName(htmlFileName) {
        const base = htmlFileName.replace(/\.html?$/i, '') || 'index';
        return `${base}.inlined.html`;
    }

    triggerDownload(text, fileName) {
        const blob = new Blob([text], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fileName;
        anchor.click();
        URL.revokeObjectURL(url);
    }
}

window.addEventListener('DOMContentLoaded', () => {
    new UIController();
});
