import { useEffect, useId, useRef, useState } from 'react';
import type { Escaleta, Scene } from '../api/types';
import { format, useI18n, type MessageKey } from '../i18n';
import { FIELD_LIMITS, MAX_SCENES, emptyScene, renumber, sceneErrors, type TextField } from '../lib/escaleta';

export interface SegmentEditorProps {
  scenes: Escaleta;
  onChange: (next: Escaleta) => void;
  /** Voice options for the per-scene selector (Piper roster via the API). Defaults to the male/female roles. */
  voices?: string[];
}

const VOICES = ['male', 'female'];

const FIELD_LABEL: Record<TextField, MessageKey> = {
  title: 'editor.title',
  narration: 'editor.narration',
  visualPrompt: 'editor.visualPrompt',
};

type Action = 'up' | 'down';

/** Controlled editor: one editable card per scene, reorder/add/delete, live validation. */
export function SegmentEditor({ scenes, onChange, voices: voiceOptions }: SegmentEditorProps) {
  const { t } = useI18n();
  const baseId = useId();
  const [announcement, setAnnouncement] = useState('');
  const listRef = useRef<HTMLOListElement>(null);
  const pendingFocus = useRef<{ index: number; action: Action } | null>(null);

  // Roles first (with their labels), then the Piper roster, never dropping a voice an existing scene already uses.
  const voiceList = voiceOptions ?? VOICES;

  // After a move, keep keyboard focus on the moved scene's control.
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const item = listRef.current?.children[target.index];
    const preferred = item?.querySelector<HTMLButtonElement>(`[data-action="${target.action}"]`);
    const other = item?.querySelector<HTMLButtonElement>(`[data-action="${target.action === 'up' ? 'down' : 'up'}"]`);
    (preferred && !preferred.disabled ? preferred : other)?.focus();
  });

  const update = (index: number, patch: Partial<Scene>) =>
    onChange(scenes.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  const move = (index: number, delta: -1 | 1) => {
    const to = index + delta;
    if (to < 0 || to >= scenes.length) return;
    const next = [...scenes];
    [next[index], next[to]] = [next[to]!, next[index]!];
    pendingFocus.current = { index: to, action: delta < 0 ? 'up' : 'down' };
    setAnnouncement(format(t('editor.moved'), { from: index + 1, to: to + 1 }));
    onChange(renumber(next));
  };

  const remove = (index: number) => {
    if (scenes.length <= 1) return;
    setAnnouncement(format(t('editor.deleted'), { n: index + 1 }));
    onChange(renumber(scenes.filter((_, i) => i !== index)));
  };

  const addBelow = (index: number) => {
    if (scenes.length >= MAX_SCENES) return;
    const next = [...scenes];
    next.splice(index + 1, 0, emptyScene(scenes[index]!.voice));
    setAnnouncement(format(t('editor.added'), { n: index + 2 }));
    onChange(renumber(next));
  };

  return (
    <div className="editor">
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <ol className="editor__list" ref={listRef}>
        {scenes.map((scene, index) => {
          const errors = sceneErrors(scene);
          const n = index + 1;
          const id = `${baseId}-${index}`;
          const voices = voiceList.includes(scene.voice) ? voiceList : [...voiceList, scene.voice];
          return (
            <li key={index} className="card scene-card" aria-label={format(t('editor.scene'), { n })}>
              <div className="scene-card__head">
                <span className="scene-badge" aria-hidden="true">
                  {n}
                </span>
                <div className="scene-card__tools">
                  <button type="button" className="btn btn--icon" data-action="up" aria-label={format(t('editor.up'), { n })} disabled={index === 0} onClick={() => move(index, -1)}>
                    ↑
                  </button>
                  <button type="button" className="btn btn--icon" data-action="down" aria-label={format(t('editor.down'), { n })} disabled={index === scenes.length - 1} onClick={() => move(index, 1)}>
                    ↓
                  </button>
                  <button type="button" className="btn btn--icon" aria-label={format(t('editor.delete'), { n })} disabled={scenes.length <= 1} onClick={() => remove(index)}>
                    ×
                  </button>
                </div>
              </div>

              {(['title', 'narration', 'visualPrompt'] as const).map((field) => {
                const error = errors[field];
                const max = FIELD_LIMITS[field];
                const fieldId = `${id}-${field}`;
                const props = {
                  id: fieldId,
                  value: scene[field],
                  'aria-invalid': error ? true : undefined,
                  'aria-describedby': `${fieldId}-count${error ? ` ${fieldId}-error` : ''}`,
                  onChange: (e: { target: { value: string } }) => update(index, { [field]: e.target.value }),
                };
                return (
                  <div key={field} className="field">
                    <label htmlFor={fieldId}>{t(FIELD_LABEL[field])}</label>
                    {field === 'title' ? <input type="text" {...props} /> : <textarea rows={field === 'narration' ? 4 : 3} {...props} />}
                    <div className="field__meta">
                      <span id={`${fieldId}-error`} className="field__error">
                        {error ? format(t(error === 'empty' ? 'editor.error.empty' : 'editor.error.tooLong'), { max }) : ''}
                      </span>
                      <span id={`${fieldId}-count`} className={`field__count${error === 'tooLong' ? ' field__count--over' : ''}`}>
                        {scene[field].length}/{max}
                      </span>
                    </div>
                  </div>
                );
              })}

              <div className="scene-card__foot">
                <div className="field field--inline">
                  <label htmlFor={`${id}-voice`}>{t('editor.voice')}</label>
                  <select id={`${id}-voice`} value={scene.voice} onChange={(e) => update(index, { voice: e.target.value })}>
                    {voices.map((v) => (
                      <option key={v} value={v}>
                        {v === 'male' ? t('form.voice.male') : v === 'female' ? t('form.voice.female') : v}
                      </option>
                    ))}
                  </select>
                </div>
                <button type="button" className="btn" aria-label={format(t('editor.add'), { n })} disabled={scenes.length >= MAX_SCENES} onClick={() => addBelow(index)}>
                  + {t('editor.addShort')}
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
