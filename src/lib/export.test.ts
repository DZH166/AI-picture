import { afterEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import type { ExportItem, ReportRow } from '../types';
import {
  canSaveToDirectory,
  createCsvReport,
  createExportEntries,
  createZip,
  sanitizeFilename,
  saveToDirectory,
} from './export';

// A real 1 × 1 PNG. ZIP export must retain these original bytes exactly.
const pngBytes = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9x0AAAAASUVORK5CYII=',
    'base64',
  ),
);

function item(name: string, sourceName = '原图.png', sourceId = 'source-1'): ExportItem {
  return {
    sourceId,
    sourceName,
    name,
    blob: new Blob([pngBytes], { type: 'image/png' }),
  };
}

const reportRow: ReportRow = {
  sourceName: '原图.png',
  status: '已完成',
  count: 2,
  durationMs: 750,
  note: '',
};

afterEach(() => vi.unstubAllGlobals());

describe('portable export filenames', () => {
  it.each(['CON', 'con.txt', 'PRN', 'AUX.png', 'NUL', 'COM1', 'LPT9', 'COM¹'])(
    'escapes the Windows reserved name %s',
    (name) => {
      expect(sanitizeFilename(name)).toBe(`_${name}`);
    },
  );

  it('removes path traversal, forbidden characters and trailing spaces or dots', () => {
    expect(sanitizeFilename('../a\\b:c*?"<>|. ')).toBe('_a_b_c______');
    expect(sanitizeFilename('\u0000abc\u001f')).toBe('_abc_');
    expect(sanitizeFilename(' . . ')).toBe('素材');
    expect(sanitizeFilename('')).toBe('素材');
    expect(sanitizeFilename('中文名字')).toBe('中文名字');
    expect(sanitizeFilename('x'.repeat(400)).length).toBeLessThanOrEqual(121);
  });

  it('does not split a surrogate pair when truncating a long name', () => {
    expect(sanitizeFilename(`${'a'.repeat(119)}😀`)).toBe('a'.repeat(119));
  });
});

describe('export layout', () => {
  it('places PNGs directly in a source folder and keeps duplicate sources separate', () => {
    const items = [item('人物.png'), item('人物.PNG'), item('人物', '原图.jpg', 'source-2')];
    const entries = createExportEntries(items, 'grouped');
    expect(entries.map((entry) => entry.path)).toEqual([
      '原图/人物.png',
      '原图/人物 (2).png',
      '原图 (2)/人物.png',
    ]);
    expect(entries[0].blob).toBe(items[0].blob);
    expect(createExportEntries(items, 'grouped')).toEqual(entries);
  });

  it('disambiguates filenames after sanitization and without case sensitivity', () => {
    const entries = createExportEntries(
      [item('A?B'), item('a*b'), item('A_B (2)'), item('A?B')],
      'flat',
    );
    expect(entries.map((entry) => entry.path)).toEqual([
      'A_B.png',
      'a_b (2).png',
      'A_B (2) (2).png',
      'A_B (3).png',
    ]);
    expect(entries.every((entry) => !entry.path.includes('/'))).toBe(true);
  });

  it('disambiguates Unicode-normalized names and case-folded source folders', () => {
    expect(
      createExportEntries([item('é'), item('e\u0301')], 'flat').map((entry) => entry.path),
    ).toEqual(['é.png', 'é (2).png']);
    expect(
      createExportEntries(
        [item('人物', 'A.png', 'one'), item('人物', 'a.png', 'two')],
        'grouped',
      ).map((entry) => entry.path),
    ).toEqual(['A/人物.png', 'a (2)/人物.png']);
  });
});

describe('CSV report', () => {
  it('includes a UTF-8 BOM and escapes commas, double quotes and newlines', () => {
    const csv = createCsvReport([
      { ...reportRow, sourceName: '中文,"引号".png', note: '第一行\r\n第二行' },
    ]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('"原图名称","处理状态","人物数量","耗时（毫秒）","备注"\r\n');
    expect(csv).toContain('"中文,""引号"".png","已完成","2","750","第一行\r\n第二行"\r\n');
  });

  it.each(['=1+1', '+cmd', '-1+1', '@SUM(A1)', ' \t=1+1', '\tcmd', '\r=1+1', '\ncmd'])(
    'neutralizes spreadsheet formulas in %j',
    (dangerous) => {
      const csv = createCsvReport([{ ...reportRow, sourceName: dangerous, note: dangerous }]);
      expect(csv).toContain(`"'${dangerous}"`);
      expect(csv.match(/"'/g)).toHaveLength(2);
    },
  );
});

describe('ZIP', () => {
  it('roundtrips PNG bytes and a UTF-8 report without an extra top-level folder', async () => {
    const blob = await createZip([item('人物')], 'grouped', [reportRow]);
    const archive = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(blob.type).toBe('application/zip');
    expect(Object.keys(archive)).toEqual(['原图/人物.png', 'report.csv']);
    expect(archive['原图/人物.png']).toEqual(pngBytes);
    expect(archive['report.csv']).toEqual(strToU8(createCsvReport([reportRow])));
    // TextDecoder (used by fflate) consumes the BOM while decoding.
    expect(strFromU8(archive['report.csv'])).toBe(createCsvReport([reportRow]).slice(1));
  });

  it('can export a report when no image succeeded', async () => {
    const blob = await createZip([], 'flat', []);
    const archive = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(archive)).toEqual(['report.csv']);
  });
});

class MemoryFile {
  data: Blob | undefined;
  createWritable() {
    return Promise.resolve({
      write: async (data: Blob) => {
        this.data = data;
      },
      close: async () => undefined,
    });
  }
}

class MemoryDirectory {
  entries = new Map<string, MemoryFile | MemoryDirectory>();

  private find(name: string): MemoryFile | MemoryDirectory | undefined {
    const key = [...this.entries.keys()].find(
      (existing) => existing.toLowerCase() === name.toLowerCase(),
    );
    return key === undefined ? undefined : this.entries.get(key);
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFile> {
    const entry = this.find(name);
    if (entry instanceof MemoryDirectory) throw new DOMException('', 'TypeMismatchError');
    if (entry) return entry;
    if (!options?.create) throw new DOMException('', 'NotFoundError');
    const file = new MemoryFile();
    this.entries.set(name, file);
    return file;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemoryDirectory> {
    const entry = this.find(name);
    if (entry instanceof MemoryFile) throw new DOMException('', 'TypeMismatchError');
    if (entry) return entry;
    if (!options?.create) throw new DOMException('', 'NotFoundError');
    const directory = new MemoryDirectory();
    this.entries.set(name, directory);
    return directory;
  }
}

describe('save to a selected directory', () => {
  it('detects support and invokes the picker synchronously before awaiting preparation', async () => {
    expect(canSaveToDirectory()).toBe(false);
    const picker = vi.fn().mockResolvedValue(new MemoryDirectory());
    vi.stubGlobal('window', { showDirectoryPicker: picker });
    expect(canSaveToDirectory()).toBe(true);
    const result = saveToDirectory([], 'flat', []);
    expect(picker).toHaveBeenCalledWith({ mode: 'readwrite' });
    await result;
  });

  it('avoids overwriting existing files and directories in grouped exports', async () => {
    const root = new MemoryDirectory();
    const existing = await root.getDirectoryHandle('原图', { create: true });
    const existingFile = await existing.getFileHandle('人物.png', { create: true });
    existingFile.data = new Blob(['keep']);
    await root.getFileHandle('原图 (2)', { create: true });
    await root.getDirectoryHandle('report.csv', { create: true });
    vi.stubGlobal('window', { showDirectoryPicker: vi.fn().mockResolvedValue(root) });

    await saveToDirectory([item('人物'), item('人物')], 'grouped', [reportRow]);

    expect(await existingFile.data.text()).toBe('keep');
    const saved = await root.getDirectoryHandle('原图 (3)');
    expect([...saved.entries.keys()]).toEqual(['人物.png', '人物 (2).png']);
    expect(
      new Uint8Array(await (await saved.getFileHandle('人物.png')).data!.arrayBuffer()),
    ).toEqual(pngBytes);
    expect(await (await root.getFileHandle('report (2).csv')).data!.text()).toContain('原图名称');
  });

  it('avoids both file and directory collisions in flat mode', async () => {
    const root = new MemoryDirectory();
    const existing = await root.getFileHandle('人物.png', { create: true });
    existing.data = new Blob(['keep']);
    await root.getDirectoryHandle('人物 (2).png', { create: true });
    vi.stubGlobal('window', { showDirectoryPicker: vi.fn().mockResolvedValue(root) });
    await saveToDirectory([item('人物')], 'flat', []);
    expect(root.entries.has('人物 (3).png')).toBe(true);
    expect(await existing.data.text()).toBe('keep');
  });

  it('propagates picker cancellation to the caller', async () => {
    const cancel = new DOMException('用户取消', 'AbortError');
    vi.stubGlobal('window', { showDirectoryPicker: vi.fn().mockRejectedValue(cancel) });
    await expect(saveToDirectory([], 'flat', [])).rejects.toBe(cancel);
  });

  it('does not treat permission failures as missing files', async () => {
    const error = new DOMException('权限不足', 'NotAllowedError');
    const root = new MemoryDirectory();
    vi.spyOn(root, 'getFileHandle').mockRejectedValue(error);
    vi.stubGlobal('window', { showDirectoryPicker: vi.fn().mockResolvedValue(root) });
    await expect(saveToDirectory([], 'flat', [])).rejects.toBe(error);
    expect(root.entries.size).toBe(0);
  });
});
