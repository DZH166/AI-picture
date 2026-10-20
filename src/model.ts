import type { ProviderSettings } from './types';

export type Page = 'workspace' | 'results' | 'settings';
export type ProcessingMode = 'local' | 'ai';
export type JobStatus = 'queued' | 'processing' | 'complete' | 'failed';

export interface Material {
  id: string;
  name: string;
  url: string;
  blob: Blob;
  width: number;
  height: number;
}

export interface Job {
  id: string;
  file: File;
  url: string;
  width: number;
  height: number;
  status: JobStatus;
  stage: string;
  error?: string;
  materials: Material[];
  warnings: string[];
  durationMs: number;
  processedSize?: string;
}

const SETTINGS_KEY = 'material-factory.settings.v1';

export function loadSettings(defaults: ProviderSettings): ProviderSettings {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return defaults;
    const v = saved as Record<string, unknown>;
    return {
      ...defaults,
      apiBaseUrl: typeof v.apiBaseUrl === 'string' ? v.apiBaseUrl : defaults.apiBaseUrl,
      modelId: typeof v.modelId === 'string' ? v.modelId : defaults.modelId,
      timeoutMs:
        typeof v.timeoutMs === 'number' && v.timeoutMs >= 5000 && v.timeoutMs <= 120000
          ? v.timeoutMs
          : defaults.timeoutMs,
      allowImageUpload: v.allowImageUpload === true,
      apiKey: '',
    };
  } catch {
    return defaults;
  }
}

export function persistSettings(settings: ProviderSettings) {
  const { apiKey: _apiKey, ...publicSettings } = settings;
  void _apiKey;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(publicSettings));
}

export function formatBytes(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function revokeJob(job: Job) {
  URL.revokeObjectURL(job.url);
  job.materials.forEach((material) => URL.revokeObjectURL(material.url));
}
