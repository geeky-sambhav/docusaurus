/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from 'fs-extra';
import path from 'path';
import _ from 'lodash';
import evaluate from 'eval';
import pMap from 'p-map';
import eta from 'eta';
import {minify} from 'html-minifier-terser';
import {getBundles} from 'react-loadable-ssr-addon-v5-slorber';
import {PerfLogger} from './utils';
import type {Manifest} from 'react-loadable-ssr-addon-v5-slorber';
import type {
  ServerEntryRenderer,
  ServerEntryResult,
  SiteCollectedData,
  ServerEntryParams,
} from './types';

// Secret way to set SSR plugin concurrency option
// Waiting for feedback before documenting this officially?
const Concurrency = process.env.DOCUSAURUS_SSR_CONCURRENCY
  ? parseInt(process.env.DOCUSAURUS_SSR_CONCURRENCY, 10)
  : // Not easy to define a reasonable option default
    // Will still be better than Infinity
    // See also https://github.com/sindresorhus/p-map/issues/24
    32;

async function loadServerEntryRenderer({
  serverBundlePath,
}: {
  serverBundlePath: string;
}): Promise<ServerEntryRenderer> {
  PerfLogger.start(`SSG - Load server bundle`);
  const source = await fs.readFile(serverBundlePath);
  PerfLogger.end(`SSG - Load server bundle`);
  PerfLogger.log(
    `SSG - Server bundle size = ${(source.length / 1024000).toFixed(3)} MB`,
  );

  const filename = path.basename(serverBundlePath);

  // When using "new URL('file.js', import.meta.url)", Webpack will emit
  // __filename, and this plugin will throw. not sure the __filename value
  // has any importance for this plugin, just using an empty string to
  // avoid the error. See https://github.com/facebook/docusaurus/issues/4922
  const globals = {__filename: ''};

  PerfLogger.start(`SSG - Evaluate server bundle`);
  const serverEntry = evaluate(
    source,
    /* filename: */ filename,
    /* scope: */ globals,
    /* includeGlobals: */ true,
  ) as {default?: ServerEntryRenderer};
  PerfLogger.end(`SSG - Evaluate server bundle`);

  if (!serverEntry?.default || typeof serverEntry.default !== 'function') {
    throw new Error(
      `Server bundle export from "${filename}" must be a function that returns an HTML string.`,
    );
  }
  return serverEntry.default;
}

function pathnameToFilename({
  pathname,
  trailingSlash,
}: {
  pathname: string;
  trailingSlash?: boolean;
}): string {
  const outputFileName = pathname.replace(/^[/\\]/, ''); // Remove leading slashes for webpack-dev-server
  // Paths ending with .html are left untouched
  if (/\.html?$/i.test(outputFileName)) {
    return outputFileName;
  }
  // Legacy retro-compatible behavior
  if (typeof trailingSlash === 'undefined') {
    return path.join(outputFileName, 'index.html');
  }
  // New behavior: we can say if we prefer file/folder output
  // Useful resource: https://github.com/slorber/trailing-slash-guide
  if (pathname === '' || pathname.endsWith('/') || trailingSlash) {
    return path.join(outputFileName, 'index.html');
  }
  return `${outputFileName}.html`;
}

export async function generateStaticFiles({
  pathnames,
  serverBundlePath,
  serverEntryParams,
}: {
  pathnames: string[];
  serverBundlePath: string;
  serverEntryParams: ServerEntryParams;
}): Promise<{collectedData: SiteCollectedData}> {
  const renderer = await loadServerEntryRenderer({
    serverBundlePath,
  });

  type SSGSuccess = {pathname: string; error: null; result: ServerEntryResult};
  type SSGError = {pathname: string; error: Error; result: null};
  type SSGResult = SSGSuccess | SSGError;

  // Note that we catch all async errors on purpose
  // Docusaurus presents all the SSG errors to the user, not just the first one
  const results: SSGResult[] = await pMap(
    pathnames,
    async (pathname) =>
      generateStaticFile({
        pathname,
        renderer,
        serverEntryParams,
      }).then(
        (result) => ({pathname, result, error: null}),
        (error) => ({pathname, result: null, error: error as Error}),
      ),
    {concurrency: Concurrency},
  );

  const [allSSGErrors, allSSGSuccesses] = _.partition(
    results,
    (r): r is SSGError => !!r.error,
  );

  if (allSSGErrors.length > 0) {
    // TODO AggregateError does not log properly with Error.cause :/
    // see also https://github.com/nodejs/node/issues/51637
    // throw new AggregateError(allErrors);

    // Workaround: log errors individually + emit an aggregated error message
    allSSGErrors.forEach((ssgError) => {
      console.error(ssgError.error);
    });
    const message = `Docusaurus static site generation failed for ${
      allSSGErrors.length
    } path${allSSGErrors.length ? 's' : ''}:\n- ${allSSGErrors
      .map((ssgError) => ssgError.pathname)
      .join('\n- ')}`;
    throw new Error(message);
  }

  const collectedData: SiteCollectedData = _.chain(allSSGSuccesses)
    .keyBy((success) => success.pathname)
    .mapValues((ssgSuccess) => ssgSuccess.result.collectedData)
    .value();

  return {collectedData};
}

async function generateStaticFile({
  pathname,
  renderer,
  serverEntryParams,
}: {
  pathname: string;
  renderer: ServerEntryRenderer;
  serverEntryParams: ServerEntryParams;
}) {
  try {
    // This only renders the app HTML
    const serverEntryResult = await renderer({pathname, serverEntryParams});
    // This renders the full page HTML, including head tags...
    const fullPageHtml = renderSSRTemplate({
      serverEntryParams,
      serverEntryResult,
    });
    const content = await minifyHtml(fullPageHtml);
    await writeStaticFile({
      pathname,
      content,
      serverEntryParams,
    });
    return serverEntryResult;
  } catch (errorUnknown) {
    throw new Error(`Can't render static file for pathname=${pathname}`, {
      cause: errorUnknown as Error,
    });
  }
}

async function writeStaticFile({
  content,
  pathname,
  serverEntryParams,
}: {
  content: string;
  pathname: string;
  serverEntryParams: ServerEntryParams;
}) {
  const filename = pathnameToFilename({
    pathname: removeBaseUrl(pathname, serverEntryParams.baseUrl),
    trailingSlash: serverEntryParams.trailingSlash,
  });
  const filePath = path.join(serverEntryParams.outDir, filename);
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content);
}

function removeBaseUrl(pathname: string, baseUrl: string): string {
  return baseUrl === '/'
    ? pathname
    : pathname.replace(new RegExp(`^${baseUrl}`), '/');
}

function getScriptsAndStylesheets({
  modules,
  manifest,
}: {
  modules: string[];
  manifest: Manifest;
}) {
  // Get all required assets for this particular page based on client
  // manifest information.
  const modulesToBeLoaded = [...manifest.entrypoints, ...Array.from(modules)];
  const bundles = getBundles(manifest, modulesToBeLoaded);
  const stylesheets = (bundles.css ?? []).map((b) => b.file);
  const scripts = (bundles.js ?? []).map((b) => b.file);
  return {scripts, stylesheets};
}

const getCompiledSSRTemplate = _.memoize((template: string) =>
  eta.compile(template.trim(), {
    rmWhitespace: true,
  }),
);

function renderSSRTemplate({
  serverEntryParams,
  serverEntryResult,
}: {
  serverEntryParams: ServerEntryParams;
  serverEntryResult: ServerEntryResult;
}) {
  const {
    ssrTemplate,
    baseUrl,
    headTags,
    preBodyTags,
    postBodyTags,
    manifest,
    noIndex,
    DOCUSAURUS_VERSION,
  } = serverEntryParams;
  const {
    html: appHtml,
    collectedData: {modules, headTags: helmet},
  } = serverEntryResult;

  const {scripts, stylesheets} = getScriptsAndStylesheets({manifest, modules});

  const htmlAttributes = helmet.htmlAttributes.toString();
  const bodyAttributes = helmet.bodyAttributes.toString();
  const metaStrings = [
    helmet.title.toString(),
    helmet.meta.toString(),
    helmet.link.toString(),
    helmet.script.toString(),
  ];
  const metaAttributes = metaStrings.filter(Boolean);

  const templateData = {
    appHtml,
    baseUrl,
    htmlAttributes,
    bodyAttributes,
    headTags,
    preBodyTags,
    postBodyTags,
    metaAttributes,
    scripts,
    stylesheets,
    noIndex,
    version: DOCUSAURUS_VERSION,
  };

  const compiled = getCompiledSSRTemplate(ssrTemplate);
  return compiled(templateData, eta.defaultConfig);
}

async function minifyHtml(html: string): Promise<string> {
  try {
    if (process.env.SKIP_HTML_MINIFICATION === 'true') {
      return html;
    }
    // Minify html with https://github.com/DanielRuf/html-minifier-terser
    return await minify(html, {
      removeComments: false,
      removeRedundantAttributes: true,
      removeEmptyAttributes: true,
      removeScriptTypeAttributes: true,
      removeStyleLinkTypeAttributes: true,
      useShortDoctype: true,
      minifyJS: true,
    });
  } catch (err) {
    throw new Error('HTML minification failed', {cause: err as Error});
  }
}
