const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

/** Produce one portable filename component, never a path. */
export function sanitizeFilename(input: string): string {
  let name = input
    .normalize('NFC')
    .replace(/[<>:"/\\|?*]/g, '_')
    // Windows forbids these literal control characters in filename components.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .trim()
    .replace(/^\.+|\.+$/g, '');

  // Limit UTF-16 units without leaving a dangling surrogate at the end.
  name = name
    .slice(0, 120)
    .replace(/[\ud800-\udbff]$/, '')
    .replace(/[ .]+$/g, '');
  if (!name) name = '素材';
  if (reservedWindowsName.test(name)) name = `_${name}`;
  return name;
}
