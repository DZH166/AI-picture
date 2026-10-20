import { useRef, useState, type PointerEvent } from 'react';
import { Download, Eraser, MousePointer2, Paintbrush, Scan, Undo2 } from 'lucide-react';
import type {
  AssetResult,
  Bounds,
  Correction,
  JobSnapshot,
  MaskStroke,
  Point,
} from '../../shared/contracts';
import { Modal } from './Modal';

interface Props {
  job: JobSnapshot;
  asset?: AssetResult;
  onClose: () => void;
  onApply: (correction: Correction, assetId?: string) => Promise<void>;
  onDownload: (asset: AssetResult) => Promise<void>;
}

export function AssetEditor({ job, asset, onClose, onApply, onDownload }: Props) {
  const [editing, setEditing] = useState(!asset);
  const [tool, setTool] = useState<'inspect' | 'box' | 'add' | 'erase'>(asset ? 'inspect' : 'box');
  const [bounds, setBounds] = useState<Bounds>(
    asset?.bounds || { x: 0, y: 0, width: 0, height: 0 },
  );
  const [label, setLabel] = useState(asset?.label || '补充素材');
  const [kind, setKind] = useState(asset?.kind || 'cutout');
  const [strokes, setStrokes] = useState<MaskStroke[]>([]);
  const [draftStroke, setDraftStroke] = useState<MaskStroke | null>(null);
  const [radius, setRadius] = useState(Math.max(2, Math.round(job.width / 300)));
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const pointer = useRef<{ start: Point; stroke?: MaskStroke } | null>(null);
  const boxOriginal = asset?.bounds;
  const maskId = 'watermark-' + (asset?.id || 'new');
  const pathFor = (stroke: MaskStroke) =>
    stroke.points.map((point, index) => (index ? 'L' : 'M') + point.x + ' ' + point.y).join(' ') +
    (stroke.points.length === 1 ? ' l0.01 0' : '');

  function point(event: PointerEvent<SVGSVGElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(job.width, ((event.clientX - rect.left) * job.width) / rect.width)),
      y: Math.max(0, Math.min(job.height, ((event.clientY - rect.top) * job.height) / rect.height)),
    };
  }
  function begin(event: PointerEvent<SVGSVGElement>) {
    if (!editing || tool === 'inspect' || working || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = point(event);
    pointer.current = { start };
    if (tool === 'add' || tool === 'erase') {
      const stroke: MaskStroke = { mode: tool, radius, points: [start] };
      pointer.current.stroke = stroke;
      setDraftStroke(stroke);
    }
  }
  function move(event: PointerEvent<SVGSVGElement>) {
    if (!pointer.current) return;
    const end = point(event);
    if (tool === 'box') {
      const start = pointer.current.start;
      const x = Math.floor(Math.min(start.x, end.x)),
        y = Math.floor(Math.min(start.y, end.y));
      setBounds({
        x,
        y,
        width: Math.min(job.width - x, Math.ceil(Math.abs(start.x - end.x))),
        height: Math.min(job.height - y, Math.ceil(Math.abs(start.y - end.y))),
      });
    } else if (pointer.current.stroke) {
      const stroke = pointer.current.stroke;
      if (stroke.points.length >= 2000) return;
      const previous = stroke.points[stroke.points.length - 1];
      if (Math.hypot(end.x - previous.x, end.y - previous.y) < 1) return;
      stroke.points = [...stroke.points, end];
      setDraftStroke({ ...stroke });
    }
  }
  function finish(event: PointerEvent<SVGSVGElement>) {
    if (!pointer.current) return;
    const completedStroke = pointer.current.stroke;
    if (completedStroke) setStrokes((current) => [...current, completedStroke]);
    pointer.current = null;
    setDraftStroke(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }
  async function apply() {
    setWorking(true);
    setError('');
    try {
      await onApply({ bounds, kind, label, mergeIds, strokes }, asset?.id);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '修正未提交。');
    } finally {
      setWorking(false);
    }
  }

  const visibleStrokes = [...strokes, ...(draftStroke ? [draftStroke] : [])];
  return (
    <Modal title={asset ? '检查素材与原图对应' : '补充一个完整素材'} onClose={onClose} wide>
      <div className="editor-intro">
        <p>
          {editing
            ? '框选完整设计，必要时只涂抹残留水印。文字、配件和装饰应作为设计的一部分保留。'
            : '左边标出素材在原图中的位置，右边显示实际输出。请检查水印、文字和轮廓。'}
        </p>
        {asset && (
          <button
            className="button secondary small"
            onClick={() => {
              setEditing(!editing);
              setTool(editing ? 'inspect' : 'box');
            }}
          >
            {editing ? '返回预览' : '修正此素材'}
          </button>
        )}
      </div>
      {editing && (
        <div className="editor-tools">
          {(
            [
              { id: 'inspect', text: '查看', Icon: MousePointer2 },
              { id: 'box', text: '调整范围', Icon: Scan },
              { id: 'add', text: '涂水印', Icon: Paintbrush },
              { id: 'erase', text: '擦除误选', Icon: Eraser },
            ] as const
          ).map(({ id, text, Icon }) => (
            <button
              key={id}
              className={'tool-button ' + (tool === id ? 'selected' : '')}
              onClick={() => setTool(id)}
            >
              <Icon size={15} />
              {text}
            </button>
          ))}
          <label className="brush-size">
            笔刷{' '}
            <input
              type="range"
              min="1"
              max={Math.min(80, Math.ceil(job.width / 15))}
              value={radius}
              onChange={(event) => setRadius(Number(event.target.value))}
            />
          </label>
          <button
            className="tool-button"
            disabled={!strokes.length}
            onClick={() => setStrokes((current) => current.slice(0, -1))}
          >
            <Undo2 size={15} />
            撤销
          </button>
        </div>
      )}
      <div className="editor-images">
        <section>
          <div className="image-label">原图位置 {editing && <span>红色为待修复区域</span>}</div>
          <div className="source-canvas">
            <svg
              className={'editor-svg ' + (tool === 'inspect' ? '' : 'drawing')}
              width={job.width}
              height={job.height}
              viewBox={'0 0 ' + job.width + ' ' + job.height}
              onPointerDown={begin}
              onPointerMove={move}
              onPointerUp={finish}
              onPointerCancel={finish}
            >
              <image href={job.originalUrl} width={job.width} height={job.height} />
              <defs>
                <mask
                  id={maskId}
                  maskUnits="userSpaceOnUse"
                  x="0"
                  y="0"
                  width={job.width}
                  height={job.height}
                >
                  <rect width={job.width} height={job.height} fill="black" />
                  {asset?.maskUrl && boxOriginal && (
                    <image
                      href={asset.maskUrl}
                      x={boxOriginal.x}
                      y={boxOriginal.y}
                      width={boxOriginal.width}
                      height={boxOriginal.height}
                    />
                  )}
                  {visibleStrokes.map((stroke, index) => (
                    <path
                      key={index}
                      d={pathFor(stroke)}
                      fill="none"
                      stroke={stroke.mode === 'add' ? 'white' : 'black'}
                      strokeWidth={stroke.radius * 2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ))}
                </mask>
              </defs>
              {editing && (
                <rect
                  width={job.width}
                  height={job.height}
                  fill="#e14545"
                  opacity=".6"
                  mask={'url(#' + maskId + ')'}
                />
              )}
              {bounds.width > 0 && (
                <>
                  <rect width={job.width} height={job.height} fill="#101519" opacity=".14" />
                  <rect
                    x={bounds.x}
                    y={bounds.y}
                    width={bounds.width}
                    height={bounds.height}
                    fill="none"
                    stroke="#15b79a"
                    strokeWidth={Math.max(2, job.width / 260)}
                  />
                  <rect
                    x={bounds.x}
                    y={bounds.y}
                    width={bounds.width}
                    height={bounds.height}
                    fill="transparent"
                  />
                </>
              )}
            </svg>
          </div>
        </section>
        <section>
          <div className="image-label">
            透明 PNG <span>{asset?.width ? asset.width + ' × ' + asset.height : '提交后生成'}</span>
            {asset?.previewUrl && (
              <a className="text-button" href={asset.previewUrl} target="_blank" rel="noreferrer">
                放大查看原尺寸
              </a>
            )}
          </div>
          <div className="editor-result checkerboard">
            {asset?.previewUrl ? (
              <img src={asset.previewUrl} alt={asset.label} />
            ) : (
              <p>
                框选后重新处理，
                <br />
                此处会显示实际结果。
              </p>
            )}
          </div>
        </section>
      </div>
      {asset && (asset.warnings.length > 0 || asset.error) && (
        <div className="editor-warnings">
          {asset.error && <p className="error">{asset.error}</p>}
          {asset.warnings.map((warning, index) => (
            <p key={index}>{warning}</p>
          ))}
        </div>
      )}
      {editing && (
        <div className="editor-form">
          <div className="editor-fields">
            <label>
              素材名称
              <input
                className="input"
                maxLength={100}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <label>
              保留方式
              <select
                className="input"
                value={kind}
                onChange={(event) => setKind(event.target.value as 'cutout' | 'rectangle')}
              >
                <option value="cutout">透明背景，保留完整图案</option>
                <option value="rectangle">保留整个矩形版面</option>
              </select>
            </label>
          </div>
          <div className="box-fields">
            {(['x', 'y', 'width', 'height'] as const).map((name, index) => (
              <label key={name}>
                {['左侧 X', '顶部 Y', '宽度', '高度'][index]}
                <input
                  className="input"
                  type="number"
                  min={name === 'x' || name === 'y' ? 0 : 2}
                  value={bounds[name]}
                  onChange={(event) =>
                    setBounds((current) => ({ ...current, [name]: Number(event.target.value) }))
                  }
                />
              </label>
            ))}
          </div>
          {asset && (
            <details className="merge-options">
              <summary>把其他部分合并到这个完整设计</summary>
              <p className="text-muted">
                只选择同一份设计的文字、配件或被拆开的部分；成功后会合并为一个输出。
              </p>
              <div>
                {job.assets
                  .filter((other) => other.id !== asset.id)
                  .map((other) => (
                    <label key={other.id}>
                      <input
                        type="checkbox"
                        checked={mergeIds.includes(other.id)}
                        onChange={(event) =>
                          setMergeIds((current) =>
                            event.target.checked
                              ? [...current, other.id]
                              : current.filter((id) => id !== other.id),
                          )
                        }
                      />
                      {other.label}
                    </label>
                  ))}
              </div>
            </details>
          )}
          <p className="text-muted">
            仅重新处理这一份素材；本次模型调用仍计入原图预算。水印遮住的细节属于推断修复，请检查效果。
          </p>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button className="button secondary" disabled={working} onClick={onClose}>
          关闭
        </button>
        {editing ? (
          <button
            className="button primary"
            disabled={working || bounds.width < 2 || bounds.height < 2 || !label.trim()}
            onClick={() => void apply()}
          >
            {working ? '正在提交…' : '仅重做此素材'}
          </button>
        ) : (
          asset?.previewUrl &&
          asset.status !== 'failed' && (
            <button
              className="button primary"
              disabled={working}
              onClick={async () => {
                setWorking(true);
                try {
                  await onDownload(asset);
                } catch (failure) {
                  setError(failure instanceof Error ? failure.message : '下载失败');
                } finally {
                  setWorking(false);
                }
              }}
            >
              <Download size={16} />
              确认并下载 PNG
            </button>
          )
        )}
      </div>
    </Modal>
  );
}
