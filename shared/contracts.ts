export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}
export type AssetKind = 'cutout' | 'rectangle';
export type AssetStatus = 'pending' | 'processing' | 'review' | 'ready' | 'failed' | 'deleted';
export type JobStatus =
  | 'queued'
  | 'analyzing'
  | 'segmenting'
  | 'repairing'
  | 'rendering'
  | 'review'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'budget_paused';
export interface Candidate {
  id: string;
  label: string;
  bounds: Bounds;
  kind: AssetKind;
  prompt: string;
}
export interface WatermarkRegion {
  bounds: Bounds;
  description: string;
  confidence: 'low' | 'medium' | 'high';
}
export interface Analysis {
  assets: Candidate[];
  watermarks: WatermarkRegion[];
  warnings: string[];
}
export interface MaskStroke {
  mode: 'add' | 'erase';
  radius: number;
  points: Point[];
}
export interface Correction {
  bounds?: Bounds;
  kind?: AssetKind;
  label?: string;
  mergeIds?: string[];
  strokes?: MaskStroke[];
}
export interface AssetResult {
  id: string;
  label: string;
  bounds: Bounds;
  kind: AssetKind;
  status: AssetStatus;
  width?: number;
  height?: number;
  previewUrl?: string;
  maskUrl?: string;
  warnings: string[];
  error?: string;
}
export interface JobSnapshot {
  id: string;
  filename: string;
  width: number;
  height: number;
  originalUrl: string;
  status: JobStatus;
  stage: string;
  createdAt: number;
  expiresAt: number;
  spentCny: number;
  budgetCny: number;
  assets: AssetResult[];
  warnings: string[];
  error?: string;
}
export interface StoredAsset extends AssetResult {
  candidate: Candidate;
  pngPath?: string;
  alphaPath?: string;
  watermarkPath?: string;
  correction?: Correction;
}
export interface StoredJob extends Omit<JobSnapshot, 'assets'> {
  ownerId: string;
  sourcePath: string;
  assets: StoredAsset[];
  analysis?: Analysis;
}
export interface RuntimeConfig {
  deepseekKey: string;
  falKey: string;
  deepseekEnabled: boolean;
  falEnabled: boolean;
  budgetCny: number;
}
export interface PublicConfig {
  deepseek: { configured: boolean; enabled: boolean; masked: string };
  fal: { configured: boolean; enabled: boolean; masked: string };
  budgetCny: number;
}
export interface ConfigUpdate {
  deepseekKey?: string;
  falKey?: string;
  deepseekEnabled?: boolean;
  falEnabled?: boolean;
  budgetCny?: number;
}
export interface PublicStatus {
  configured: boolean;
  available: boolean;
  adminSetupRequired: boolean;
  adminLocal: boolean;
  message: string;
}
export interface FailureRecord {
  at: number;
  filename: string;
  stage: string;
  message: string;
}
export const ACTIVE_STATUSES: JobStatus[] = [
  'queued',
  'analyzing',
  'segmenting',
  'repairing',
  'rendering',
];
