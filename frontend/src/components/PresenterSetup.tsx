import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ApiError, type ApiClient } from '../api/client';
import type { Character } from '../api/types';
import { useI18n } from '../i18n';

export interface PresenterSetupProps {
  api: Pick<ApiClient, 'listCharacters' | 'createCharacter' | 'approveCharacter' | 'deleteCharacter'>;
  /** Character ids currently chosen ('' = none). */
  a: string;
  b: string;
  onChange(next: { a: string; b: string }): void;
}

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;

interface CardProps {
  character: Character;
  headingRef: (el: HTMLHeadingElement | null) => void;
  onApprove: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

function CharacterCard({ character, headingRef, onApprove, onDelete }: CardProps) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const yesRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  useEffect(() => {
    if (confirming) yesRef.current?.focus();
  }, [confirming]);

  const cancelConfirm = () => {
    setConfirming(false);
    // The Delete button is rendered again on the next commit.
    setTimeout(() => deleteRef.current?.focus(), 0);
  };

  const run = async (action: (id: string) => Promise<void>, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      await action(character.id);
    } catch {
      if (alive.current) {
        setError(failure);
        setConfirming(false);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (confirming && e.key === 'Escape') {
      e.stopPropagation();
      cancelConfirm();
    }
  };

  return (
    <li className="presenters__card" onKeyDown={onKeyDown}>
      <img
        className="presenters__img"
        src={character.imageUrl}
        alt={t('presenters.imageAlt', { name: character.name })}
        loading="lazy"
        width={character.width}
        height={character.height}
      />
      <h4 ref={headingRef} tabIndex={-1}>
        {character.name}
      </h4>
      <p className="presenters__desc">{character.description}</p>
      <span className="presenters__badge" data-status={character.status}>
        {t(character.status === 'approved' ? 'presenters.status.approved' : 'presenters.status.generated')}
      </span>
      {confirming ? (
        <div className="presenters__confirm" role="group" aria-label={t('presenters.confirmDelete')}>
          <span>{t('presenters.confirmDelete')}</span>
          <button
            type="button"
            className="btn btn--danger"
            ref={yesRef}
            disabled={busy}
            onClick={() => void run(onDelete, t('presenters.err.delete'))}
          >
            {t('presenters.deleteYes')}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={cancelConfirm}>
            {t('presenters.deleteNo')}
          </button>
        </div>
      ) : (
        <div className="presenters__confirm">
          {character.status === 'generated' && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void run(onApprove, t('presenters.err.approve'))}
            >
              {t('presenters.approve')}
            </button>
          )}
          <button type="button" className="btn btn--danger" ref={deleteRef} disabled={busy} onClick={() => setConfirming(true)}>
            {t('presenters.delete')}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </li>
  );
}

export function PresenterSetup({ api, a, b, onChange }: PresenterSetupProps) {
  const { t } = useI18n();
  const uid = useId();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [pending, setPending] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const headings = useRef(new Map<string, HTMLHeadingElement>());
  const nameRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setListError(false);
    api
      .listCharacters()
      .then((list) => {
        if (alive.current) setCharacters(list);
      })
      .catch(() => {
        if (alive.current) setListError(true);
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(load, [load]);

  useEffect(() => {
    if (focusId) {
      headings.current.get(focusId)?.focus();
      setFocusId(null);
    }
  }, [focusId, characters]);

  const approved = useMemo(() => characters.filter((c) => c.status === 'approved'), [characters]);
  const selA = approved.some((c) => c.id === a) ? a : '';
  const selB = b !== selA && approved.some((c) => c.id === b) ? b : '';

  const blank = name.trim() === '' || description.trim() === '';

  const mapCreateError = (e: unknown): string => {
    if (e instanceof ApiError) {
      switch (e.status) {
        case 429:
          return t('presenters.err.busy');
        case 503:
          return t('presenters.err.comfy');
        case 502:
          return `${t('presenters.err.generation')}: ${e.message}`;
        case 422:
          return `${t('presenters.err.analysis')}: ${e.message}`;
        case 400:
          return e.message;
      }
    }
    return t('presenters.err.generic');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending || blank) return;
    setPending(true);
    setCreateError(null);
    try {
      const created = await api.createCharacter({ name: name.trim(), description: description.trim() });
      if (!alive.current) return;
      setCharacters((list) => [created, ...list]);
      setName('');
      setDescription('');
      setFocusId(created.id);
    } catch (err) {
      if (alive.current) setCreateError(mapCreateError(err));
    } finally {
      if (alive.current) setPending(false);
    }
  };

  const approve = async (id: string) => {
    const updated = await api.approveCharacter(id);
    if (alive.current) setCharacters((list) => list.map((c) => (c.id === id ? updated : c)));
  };

  const remove = async (id: string) => {
    await api.deleteCharacter(id);
    if (!alive.current) return;
    setCharacters((list) => list.filter((c) => c.id !== id));
    if (a === id || b === id) onChange({ a: a === id ? '' : selA, b: b === id ? '' : selB });
    // The Generate button may be disabled (blank form), so focus returns to the form's first field.
    setTimeout(() => nameRef.current?.focus(), 0);
  };

  const optionsFor = (other: string) =>
    approved.map((c) => (
      <option key={c.id} value={c.id} disabled={c.id === other}>
        {c.name}
      </option>
    ));

  return (
    <div className="presenters">
      <p className="presenters__intro">{t('presenters.intro')}</p>

      <form onSubmit={(e) => void submit(e)}>
        <fieldset className="presenters__form" aria-busy={pending}>
          <legend>{t('presenters.title')}</legend>
          <div className="field">
            <label htmlFor={`${uid}-name`}>{t('presenters.name')}</label>
            <input
              id={`${uid}-name`}
              ref={nameRef}
              type="text"
              maxLength={NAME_MAX}
              value={name}
              disabled={pending}
              onChange={(e) => {
                setName(e.target.value);
                setCreateError(null);
              }}
            />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-description`}>{t('presenters.description')}</label>
            <textarea
              id={`${uid}-description`}
              maxLength={DESCRIPTION_MAX}
              value={description}
              disabled={pending}
              onChange={(e) => {
                setDescription(e.target.value);
                setCreateError(null);
              }}
            />
          </div>
          <div>
            <button type="submit" className="btn btn--primary" disabled={pending || blank}>
              {pending ? t('presenters.generating') : t('presenters.create')}
            </button>
          </div>
          {pending && (
            <p role="status" className="presenters__note">
              {t('presenters.generatingNote')}
            </p>
          )}
          {createError && (
            <p role="alert" className="form-error">
              {createError}
            </p>
          )}
        </fieldset>
      </form>

      {listError && (
        <div role="alert" className="form-error">
          <span>{t('presenters.loadError')} </span>
          <button type="button" className="btn" onClick={load}>
            {t('presenters.retry')}
          </button>
        </div>
      )}

      {!loading && !listError && (
        <ul className="presenters__grid" aria-label={t('presenters.list')}>
          {characters.map((c) => (
            <CharacterCard
              key={c.id}
              character={c}
              headingRef={(el) => {
                if (el) headings.current.set(c.id, el);
                else headings.current.delete(c.id);
              }}
              onApprove={approve}
              onDelete={remove}
            />
          ))}
        </ul>
      )}

      <div className="presenters__pickers">
        <div className="field">
          <label htmlFor={`${uid}-a`}>{t('presenters.pickA')}</label>
          <select
            id={`${uid}-a`}
            value={selA}
            disabled={approved.length === 0}
            onChange={(e) => onChange({ a: e.target.value, b: selB })}
          >
            <option value="">{t('presenters.pickNone')}</option>
            {optionsFor(selB)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-b`}>{t('presenters.pickB')}</label>
          <select
            id={`${uid}-b`}
            value={selB}
            disabled={approved.length === 0}
            onChange={(e) => onChange({ a: selA, b: e.target.value })}
          >
            <option value="">{t('presenters.pickNone')}</option>
            {optionsFor(selA)}
          </select>
        </div>
      </div>

      {approved.length === 0 && !loading && <p className="presenters__note">{t('presenters.noApproved')}</p>}
      {selA && selB && <p className="presenters__note">{t('presenters.ready')}</p>}
      {(selA !== '') !== (selB !== '') && (
        <p role="note" className="presenters__note">
          {t('presenters.needBoth')}
        </p>
      )}
    </div>
  );
}
