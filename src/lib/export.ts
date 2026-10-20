import { strToU8, zip, type Zippable } from 'fflate';
import type { ExportItem, ExportMode, ReportRow } from '../types';

export interface ExportEntry {
  path: string;
  blob: Blob;
}

interface WritableFile {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

interface SaveFileHandle {
  createWritable(): Promise<WritableFile>;
}

interface SaveDirectoryHandle {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<SaveFileHandle>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<SaveDirectoryHandle>;
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<SaveDirectoryHandle>;
};

const imageExtension = /\.(?:png|jpe?g|webp|gif|bmp|tiff?|avif|heic)$/i;
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

function comparisonKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

function nextName(base: string, extension: string, index: number): string {
  return `${base}${index === 1 ? '' : ` (${index})`}${extension}`;
}

function reserveName(used: Set<string>, base: string, extension = ''): string {
  let index = 1;
  let name = nextName(base, extension, index);
  while (used.has(comparisonKey(name))) {
    index += 1;
    name = nextName(base, extension, index);
  }
  used.add(comparisonKey(name));
  return name;
}

export function createExportEntries(items: ExportItem[], mode: ExportMode): ExportEntry[] {
  const sourceFolders = new Map<string, string>();
  const usedFolders = new Set<string>();
  const usedFilesByFolder = new Map<string, Set<string>>();

  return items.map((item) => {
    let folder = '';
    if (mode === 'grouped') {
      const existing = sourceFolders.get(item.sourceId);
      if (existing !== undefined) {
        folder = existing;
      } else {
        folder = reserveName(
          usedFolders,
          sanitizeFilename(item.sourceName.replace(imageExtension, '')),
        );
        sourceFolders.set(item.sourceId, folder);
      }
    }
    let usedFiles = usedFilesByFolder.get(folder);
    if (!usedFiles) {
      usedFiles = new Set<string>();
      usedFilesByFolder.set(folder, usedFiles);
    }
    const basename = sanitizeFilename(item.name.replace(/\.png$/i, ''));
    const filename = reserveName(usedFiles, basename, '.png');
    return { path: folder ? `${folder}/${filename}` : filename, blob: item.blob };
  });
}

function csvCell(value: string | number): string {
  let text = String(value);
  // Quotes alone do not prevent spreadsheet software from evaluating formulas.
  if (/^[\s\u200b]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

export function createCsvReport(rows: ReportRow[]): string {
  const header = ['原图名称', '处理状态', '人物数量', '耗时（毫秒）', '备注'];
  const records: Array<Array<string | number>> = [
    header,
    ...rows.map((row) => [row.sourceName, row.status, row.count, row.durationMs, row.note]),
  ];
  return `\uFEFF${records.map((record) => record.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export async function createZip(
  items: ExportItem[],
  mode: ExportMode,
  rows: ReportRow[],
): Promise<Blob> {
  const archive: Zippable = Object.create(null) as Zippable;
  const entries = createExportEntries(items, mode);
  const contents = await Promise.all(entries.map((entry) => entry.blob.arrayBuffer()));
  entries.forEach((entry, index) => {
    archive[entry.path] = new Uint8Array(contents[index]);
  });
  archive['report.csv'] = strToU8(createCsvReport(rows));

  return new Promise<Blob>((resolve, reject) => {
    // PNGs are already compressed. Storing them avoids unnecessary CPU work.
    zip(archive, { level: 0 }, (error, data) => {
      if (error) reject(error);
      else resolve(new Blob([data], { type: 'application/zip' }));
    });
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = sanitizeFilename(filename);
  try {
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    // Give the browser time to consume the object URL before releasing it.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

export function canSaveToDirectory(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function'
  );
}

function errorName(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'name' in error
    ? String(error.name)
    : undefined;
}

async function diskNameExists(directory: SaveDirectoryHandle, name: string): Promise<boolean> {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (error) {
    const name = errorName(error);
    // The same name can belong to a directory; that is a collision as well.
    if (name === 'TypeMismatchError') return true;
    if (name === 'NotFoundError') return false;
    throw error;
  }
}

async function availableDiskName(
  directory: SaveDirectoryHandle,
  basename: string,
  extension = '',
): Promise<string> {
  let index = 1;
  let name = nextName(basename, extension, index);
  while (await diskNameExists(directory, name)) {
    index += 1;
    name = nextName(basename, extension, index);
  }
  return name;
}

async function writeFile(
  directory: SaveDirectoryHandle,
  basename: string,
  extension: string,
  blob: Blob,
): Promise<void> {
  const filename = await availableDiskName(directory, basename, extension);
  const file = await directory.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    await writable.abort?.().catch(() => undefined);
    throw error;
  }
}

export async function saveToDirectory(
  items: ExportItem[],
  mode: ExportMode,
  rows: ReportRow[],
): Promise<void> {
  if (!canSaveToDirectory()) {
    throw new Error('当前浏览器不支持直接保存到文件夹，请使用 ZIP 导出。');
  }
  const pickerWindow = window as DirectoryPickerWindow;
  // Invoke before any other awaited work, while the click still has user activation.
  const root = await pickerWindow.showDirectoryPicker!({ mode: 'readwrite' });
  const folders = new Map<string, SaveDirectoryHandle>();

  for (const entry of createExportEntries(items, mode)) {
    const separator = entry.path.lastIndexOf('/');
    const folder = separator === -1 ? '' : entry.path.slice(0, separator);
    const filename = entry.path.slice(separator + 1);
    let directory = root;
    if (folder) {
      let handle = folders.get(folder);
      if (!handle) {
        const diskFolder = await availableDiskName(root, folder);
        handle = await root.getDirectoryHandle(diskFolder, { create: true });
        folders.set(folder, handle);
      }
      directory = handle;
    }
    await writeFile(directory, filename.slice(0, -4), '.png', entry.blob);
  }

  await writeFile(
    root,
    'report',
    '.csv',
    new Blob([createCsvReport(rows)], { type: 'text/csv;charset=utf-8' }),
  );
}
