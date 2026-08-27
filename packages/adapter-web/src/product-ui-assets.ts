/** Browser assets served by the product Worker. Text assets are generated from canonical source files. */

/**
 * Browser assets served by the product Worker. They are deliberately bundled
 * with the authenticated control adapter so the production UI does not depend
 * on Vinext fallback routing or an untracked CDN.
 */
function decodeBase64Asset(encoded: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(encoded);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

/** Derived from docs/assets/brand/mind-diary-app-icon.svg. */
export const PRODUCT_UI_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 112 112"><rect width="112" height="112" rx="26" fill="#FFF7E8"/><g transform="translate(8 8)"><path fill="#182642" d="M12 31c0-6 5-10 11-10 10 0 19 4 25 11v44c-9-7-19-10-31-9-3 0-5-2-5-5V31Z"/><path fill="#EB6F64" d="M84 31c0-6-5-10-11-10-10 0-19 4-25 11v44c9-7 19-10 31-9 3 0 5-2 5-5V31Z"/><path fill="#9AAE9D" d="M32 8h24c6 0 10 4 10 9s-4 9-10 9H46l-7 6 2-6h-9c-6 0-10-4-10-9s4-9 10-9Z"/><path fill="#FFF7E8" d="M47 11c.7 4 2 5.3 6 6-4 .7-5.3 2-6 6-.7-4-2-5.3-6-6 4-.7 5.3-2 6-6Z"/><circle cx="48" cy="74" r="10" fill="#FFF7E8"/><circle cx="48" cy="74" r="7" fill="#6C4BB6"/></g></svg>`;

export const PRODUCT_UI_FAVICON_ICO = decodeBase64Asset(
  "AAABAAIAEBAQAAEABAAoAQAAJgAAACAgEAABAAQA6AIAAE4BAAAoAAAAEAAAACAAAAABAAQAAAAAAIAAAAAAAAAAAAAAABAAAAAQAAAAAAAAAJuomgDo9/8Aw9LiANjj7QC2x7wAY1NIAI2W5ABKMioAQSUXAGRv6wBgZtIAmXauAMuTqgAAAAAAAAAAAAAyIiIiIiQABCIiIiIiIkASIiIiIiIiJCIiIi3SIiIiIiIkPcQiIiIiRmaMeqdyIiI4mZi6qqQiIjiZmLqqpCIiOJmYuqqkIiI4mZi6qqQiIkiYhnqqpCIiIWEVUXdyIiIiURVRUiIiEiJFVVVCIiMDIiIiIiIiQAASIiIiIiEAwAMAAIABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQAAwAMAACgAAAAgAAAAQAAAAAEABAAAAAAAAAIAAAAAAAAAAAAAEAAAABAAAAAAAAAAmnqcANHN2QDo9/8A1uPpAJ2umQCnr6gAnaryAEImGABcSD0AYmnTAGRv6wBKMi0AqlRtAAAAAAAAAAAAAAAEMzMzMzMzMzMzMzUAAAACMzMzMzMzMzMzMzMzQAAAQzMzMzMzMzMzMzMzMzMABTMzMzMzMzMzMzMzMzMzQAMzMzMzMzMzMzMzMzMzMzVTMzMzMzMzMzMzMzMzMzMzQzMzMzMzM0YUMzMzMzMzMzMzMzMzMzMd3UMzMzMzMzMzMzMzMzMz3d1DMzMzMzMzMzMzMzM0Ym3RREMzMzMzMzMzM10dmYliJHu3d3czMzMzMzTIiIiIwXu7u7u7czMzMzM2iIiIiIyru7u7u3MzMzMzNoiIiIiMq7u7u7tzMzMzMzaIiIiIjKu7u7u7czMzMzM2iIiIiIyru7u7u3MzMzMzNoiIiIiMq7u7u7tzMzMzMzaIiIiIjKu7u7u7czMzMzM2iIiIiIyru7u7u3MzMzMzNoiIiIiMq7u7u7tzMzMzMzaIiIiJybu7u7u7czMzMzM0yIiMyRZHu7u7u3MzMzMzM1iJFVVWZlWru7czMzMzMzM2FVVVVmVVZ3dzMzMzMzMzM0VVVWNGVVQzMzMzM0MzMzNFVVVkRVVUMzMzMzMTMzMzNFVVVlVVQzMzMzM0AzMzMzNERERERDMzMzMzMAAzMzMzMzMzMzMzMzMzMyAAUzMzMzMzMzMzMzMzMzQAAABDMzMzMzMzMzMzMzMgAAAAASMzMzMzMzMzMzRQAAD4AAAP4AAAB8AAAAOAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAABwAAAAcAAAAPwAAAH+AAAHw==",
);

export const PRODUCT_UI_FAVICON_PNG = decodeBase64Asset(
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAKlBMVEUAAACceprZzdH/9+jp49aZrp2or6fyqp0YJkI9SFzTaWLrb2QtMkptVKq27P0sAAAAAXRSTlMAQObYZgAAALRJREFUOMvlk1EOxCAIBQURper9r7tQm1bdLhfY+TBp3hSNQggGYPyCUrih+A6OOMWf0ClEB5xzupkMPd9zKINtoXkTWnOizQhbgUj8LjCkYVjOWVmFVIrAENQ4qpJngVpRWhNgyvUiTwKXgTSp1RO0yvHPwrhJyyG/CjF16CJFGNHuOj+vNTccMXLvsLXU2oNdWXt8E+BbWD+JYRsSbyqutvbzFPwS5E3m2MBA939nvM/5/wCT+RL6hpwE9QAAAABJRU5ErkJggg==",
);

export const PRODUCT_UI_APPLE_TOUCH_ICON_PNG = decodeBase64Asset(
  "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",
);

export const PRODUCT_UI_LOCKUP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 408 96" role="img" aria-labelledby="title desc"><title id="title">Mind Diary logo</title><desc id="desc">Mind Diary mark and wordmark.</desc><g><path fill="#182642" d="M12 31c0-6 5-10 11-10 10 0 19 4 25 11v44c-9-7-19-10-31-9-3 0-5-2-5-5V31Z"/><path fill="#EB6F64" d="M84 31c0-6-5-10-11-10-10 0-19 4-25 11v44c9-7 19-10 31-9 3 0 5-2 5-5V31Z"/><path fill="#9AAE9D" d="M32 8h24c6 0 10 4 10 9s-4 9-10 9H46l-7 6 2-6h-9c-6 0-10-4-10-9s4-9 10-9Z"/><path fill="#FFF7E8" d="M47 11c.7 4 2 5.3 6 6-4 .7-5.3 2-6 6-.7-4-2-5.3-6-6 4-.7 5.3-2 6-6Z"/><circle cx="48" cy="74" r="10" fill="#FFF7E8"/><circle cx="48" cy="74" r="7" fill="#6C4BB6"/></g><text x="112" y="61" fill="#182642" font-family="Fraunces, Georgia, serif" font-size="43" font-weight="650">Mind Diary</text></svg>`;

export const PRODUCT_UI_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" role="img" aria-labelledby="title desc"><title id="title">Mind Diary mark</title><desc id="desc">An open diary forming a soft letter M, with a Memory dot and a conversation bubble.</desc><path fill="#182642" d="M12 31c0-6 5-10 11-10 10 0 19 4 25 11v44c-9-7-19-10-31-9-3 0-5-2-5-5V31Z"/><path fill="#EB6F64" d="M84 31c0-6-5-10-11-10-10 0-19 4-25 11v44c9-7 19-10 31-9 3 0 5-2 5-5V31Z"/><path fill="#9AAE9D" d="M32 8h24c6 0 10 4 10 9s-4 9-10 9H46l-7 6 2-6h-9c-6 0-10-4-10-9s4-9 10-9Z"/><path fill="#FFF7E8" d="M47 11c.7 4 2 5.3 6 6-4 .7-5.3 2-6 6-.7-4-2-5.3-6-6 4-.7 5.3-2 6-6Z"/><circle cx="48" cy="74" r="10" fill="#FFF7E8"/><circle cx="48" cy="74" r="7" fill="#6C4BB6"/></svg>`;

export {
  PRODUCT_COLLABORATION_CLIENT_JAVASCRIPT,
  PRODUCT_CONNECTIONS_CLIENT_JAVASCRIPT,
  PRODUCT_EXPORT_CLIENT_JAVASCRIPT,
  PRODUCT_MARKDOWN_IMPORT_CLIENT_JAVASCRIPT,
  PRODUCT_ORDINARY_MINDS_CLIENT_JAVASCRIPT,
  PRODUCT_SHELL_INTERACTIONS_JAVASCRIPT,
  PRODUCT_UI_CLIENT_JAVASCRIPT,
  PRODUCT_UI_SHELL_CSS,
  PRODUCT_UI_TOKENS_CSS,
  PRODUCT_VISIBILITY_CATALOG_CLIENT_JAVASCRIPT,
} from "./product-ui-assets.generated.js";
