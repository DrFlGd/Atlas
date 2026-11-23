import type { LicenceBlockForm, ReadingWay } from '@atlas/importer-api';
import { useEffect, useId, useRef, useState } from 'react';
import { LICENCE_FIELD_LABELS } from '../state/licenceWords';
import type { EditorProblem } from '../state/rulesEditor';
import {
  ALL_WAYS,
  KNOWN_LICENCES,
  LICENCE_FORM_CHOICES,
  LICENCE_FORM_WORDS,
  compareWithShipped,
  licenceFormIn,
  licenceInForm,
  licenceWith,
  parsed,
  problemIsFor,
  putBackText,
  sameValue,
  setInText,
  valueInWords,
  waysIn,
  waysWith,
  type FormGroup,
  type RulesFormRead,
  type Setting,
  type SettingSet,
  type ShippedSetting,
} from '../state/rulesForm';
import { WAY_NAMES, type ShippedRules } from '../state/siteRules';

/**
 * The settings view of the rules file editor (see `state/rulesForm.ts`):
 * the simple choices of the file as ordinary controls, one group per part
 * (or one for a reader's defaults), each a change of the same text the JSON
 * view shows. Selectors, addresses and the map's data stay in the JSON: each
 * group says in one line what else it sets, with a way to the JSON view.
 *
 * On a copy of a file an importer comes with (the same site id, or the
 * same reader), each setting that differs from the shipped file is marked,
 * with the shipped value in words and "Put back" for that one setting; and
 * "Revert to defaults" removes the person's copy, after they confirm.
 */

const listOf = (items: readonly string[]) =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

export function RulesForm({
  text,
  read,
  problems,
  shipped,
  savedCopy,
  reverted,
  onChange,
  onOpenJson,
  onRevert,
}: {
  text: string;
  read: RulesFormRead;
  problems: readonly EditorProblem[];
  /** The shipped file this file is a copy of, when an importer comes with one of its key. */
  shipped: ShippedRules | null;
  /** The person's own file of that key in the Sites folder, which reverting removes. */
  savedCopy: string | null;
  /** The file was just reverted to the shipped file, and whether the person's file was removed. */
  reverted: { removed: boolean } | null;
  onChange: (text: string) => void;
  onOpenJson: () => void;
  onRevert: () => Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  const [working, setWorking] = useState(false);
  if (!read.ok) {
    return (
      <div className="rules-form" data-testid="rules-form">
        <p className="rules-form-why" data-testid="rules-form-why">
          {read.why}
        </p>
        <div className="row-actions">
          <button
            type="button"
            className="button button-small"
            data-testid="rules-form-open-json"
            onClick={onOpenJson}
          >
            Open the JSON view
          </button>
        </div>
      </div>
    );
  }
  const compared = shipped ? compareWithShipped(read, shipped.value) : new Map<string, never>();
  const changed = [...compared.values()].filter((one) => one.changed).length;
  const now = parsed(text);
  const differs = shipped !== null && (now === undefined || !sameValue(now, shipped.value));
  return (
    <div className="rules-form" data-testid="rules-form">
      {shipped ? (
        <div className="rules-form-head" data-testid="rules-form-head">
          <p className="small" data-testid="rules-form-compared" aria-live="polite">
            {reverted
              ? `Reverted to the defaults: ${reverted.removed ? 'your file was removed, and the' : 'the'} shipped file ${shipped.name} applies again.`
              : `Compared with the shipped file ${shipped.name}, which comes with ${shipped.importer}. `}
            {reverted
              ? ''
              : changed === 0
                ? differs
                  ? 'Every setting here is as shipped; the file differs only in what the JSON view shows.'
                  : 'Every setting is as shipped.'
                : changed === 1
                  ? 'One setting is changed.'
                  : `${changed.toLocaleString('en')} settings are changed.`}
          </p>
          {(differs || savedCopy !== null) && !asking ? (
            <div className="row-actions">
              <button
                type="button"
                className="button button-small"
                data-testid="rules-form-revert"
                onClick={() => {
                  setAsking(true);
                }}
              >
                Revert to defaults
              </button>
            </div>
          ) : null}
          {asking ? (
            <RevertConfirm
              name={savedCopy ?? shipped.name}
              importer={shipped.importer}
              saved={savedCopy !== null}
              working={working}
              onConfirm={() => {
                setWorking(true);
                void onRevert().then(() => {
                  setWorking(false);
                  setAsking(false);
                });
              }}
              onCancel={() => {
                setAsking(false);
              }}
            />
          ) : null}
        </div>
      ) : null}
      {read.groups.map((group) => (
        <GroupSettings
          key={group.field || 'file'}
          text={text}
          group={group}
          problems={problems}
          compared={compared}
          onChange={onChange}
          onOpenJson={onOpenJson}
        />
      ))}
    </div>
  );
}

/**
 * The confirmation of "Revert to defaults", in the app's own words: the
 * file it is for, that the person's changes to it are removed, and that the
 * shipped file applies again. Cancel has the focus first.
 */
export function RevertConfirm({
  name,
  importer,
  saved,
  working,
  onConfirm,
  onCancel,
}: {
  /** The person's file, or the shipped file's name for a copy not saved yet. */
  name: string;
  importer: string;
  /** The person's file is in the Sites folder, and is removed. */
  saved: boolean;
  working: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  const question = `Revert ${name} to the defaults?`;
  return (
    <div
      className="download-confirm rules-form-revert-ask"
      role="alertdialog"
      aria-label={question}
      data-testid="rules-revert-confirm"
    >
      <p>
        <strong>{question}</strong>{' '}
        {saved
          ? `Your file ${name} is removed from the Sites folder, with your changes to it, and the shipped file that comes with ${importer} applies again.`
          : `Your changes to it are removed, and the shipped file that comes with ${importer} applies again.`}
      </p>
      <div className="row-actions wrap">
        <button
          type="button"
          className="button button-primary"
          data-testid="rules-revert-yes"
          disabled={working}
          onClick={onConfirm}
        >
          {working ? 'Reverting…' : 'Revert to defaults'}
        </button>
        <button
          ref={cancelRef}
          type="button"
          className="button"
          data-testid="rules-revert-no"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** One group: the site, a part, a reader's defaults or the file, as a set of fields with its legend. */
function GroupSettings({
  text,
  group,
  problems,
  compared,
  onChange,
  onOpenJson,
}: {
  text: string;
  group: FormGroup;
  problems: readonly EditorProblem[];
  compared: ReadonlyMap<string, ShippedSetting>;
  onChange: (text: string) => void;
  onOpenJson: () => void;
}) {
  const alsoWho =
    group.kind === 'part'
      ? 'This part also sets'
      : group.kind === 'defaults'
        ? 'These defaults also set'
        : group.kind === 'site'
          ? 'The file also sets, for the site'
          : 'The file also has';
  const ways = group.settings.find((setting) => setting.control.type === 'ways');
  const row = (setting: Setting) => (
    <SettingRow
      key={setting.field}
      setting={setting}
      problems={problems.filter((problem) => problemIsFor(setting, problem.field))}
      shipped={compared.get(setting.field) ?? null}
      noWays={
        setting.control.type === 'pause' &&
        ways?.control.type === 'ways' &&
        !ways.control.required &&
        waysIn(ways.value).length === 0
      }
      set={(value) => {
        onChange(setInText(text, setting.path, value, group.base.length));
      }}
      putBack={(one) => {
        onChange(putBackText(text, group, setting, one));
      }}
    />
  );
  return (
    <fieldset className="rules-form-group" data-testid="rules-form-group" data-field={group.field}>
      <legend>{group.title}</legend>
      {settingRuns(group.settings).map((run) =>
        run.within ? (
          <SettingSetBox key={run.settings[0]!.field} set={run.within}>
            {run.settings.map(row)}
          </SettingSetBox>
        ) : (
          run.settings.map(row)
        ),
      )}
      {group.also.length > 0 ? (
        <p className="muted small rules-form-also" data-testid="rules-form-also">
          {alsoWho}: {listOf(group.also)}.{' '}
          <button type="button" className="link-button" onClick={onOpenJson}>
            Open the JSON view
          </button>
        </p>
      ) : null}
    </fieldset>
  );
}

/** The settings of a group in runs: those of one set together, each other setting alone. */
function settingRuns(
  settings: readonly Setting[],
): { within: SettingSet | null; settings: Setting[] }[] {
  const runs: { within: SettingSet | null; settings: Setting[] }[] = [];
  for (const setting of settings) {
    const last = runs.at(-1);
    const within = setting.within ?? null;
    if (last && within && last.within?.title === within.title) last.settings.push(setting);
    else runs.push({ within, settings: [setting] });
  }
  return runs;
}

/** A set of settings shown together, under its title, with what they are for. */
function SettingSetBox({ set, children }: { set: SettingSet; children: React.ReactNode }) {
  const hintId = useId();
  return (
    <fieldset className="rules-form-set" data-testid="rules-form-set" aria-describedby={hintId}>
      <legend className="rules-form-label">{set.title}</legend>
      <p id={hintId} className="muted small rules-form-hint">
        {set.hint}
      </p>
      {children}
    </fieldset>
  );
}

/** One setting: its control, what it is for, its problems, and how it differs from the shipped file. */
function SettingRow({
  setting,
  problems,
  shipped,
  noWays,
  set,
  putBack,
}: {
  setting: Setting;
  problems: readonly EditorProblem[];
  shipped: ShippedSetting | null;
  /** For the pause: no ways are set, so the reader's defaults hold, pause and all. */
  noWays: boolean;
  set: (value: unknown) => void;
  putBack: (shipped: ShippedSetting) => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const problemId = `${id}-problem`;
  const shippedId = `${id}-shipped`;
  const changed = shipped?.changed === true;
  const hint = noWays
    ? 'Tick a way of reading first: until then, the reader’s defaults hold for the pause too.'
    : setting.hint;
  const describedBy =
    [hint ? hintId : '', problems.length > 0 ? problemId : '', changed ? shippedId : '']
      .filter(Boolean)
      .join(' ') || undefined;
  const mark = changed ? (
    <span className="badge rules-form-changed" data-testid="rules-form-changed">
      Changed
    </span>
  ) : null;
  const control = setting.control;
  const common = { id, describedBy, invalid: problems.length > 0 };
  let body: React.ReactNode;
  switch (control.type) {
    case 'ways':
      body = (
        <fieldset className="rules-form-choices" aria-describedby={describedBy}>
          <legend className="rules-form-label">
            {setting.label} {mark}
          </legend>
          <div className="rules-form-ticks">
            {ALL_WAYS.map((way: ReadingWay) => {
              const ways = waysIn(setting.value);
              const on = ways.includes(way);
              return (
                <label key={way} className="checkbox-row" data-testid={`rules-form-way-${way}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={on && ways.length === 1}
                    onChange={(event) => {
                      const next = waysWith(setting.value, way, event.target.checked);
                      set(next.length > 0 ? next : undefined);
                    }}
                  />
                  {WAY_NAMES[way]}
                </label>
              );
            })}
          </div>
        </fieldset>
      );
      break;
    case 'pause':
      body = (
        <>
          <Label htmlFor={id} mark={mark}>
            {setting.label}
          </Label>
          <NumberInput
            {...common}
            value={setting.value}
            min={control.min}
            max={control.max}
            disabled={noWays}
            set={set}
          />
        </>
      );
      break;
    case 'number':
      body = (
        <>
          <Label htmlFor={id} mark={mark}>
            {setting.label}
          </Label>
          <NumberInput
            {...common}
            value={setting.value}
            min={control.min}
            max={control.max}
            disabled={false}
            set={set}
            whole
            unit={control.unit}
            unset={control.unset}
          />
        </>
      );
      break;
    case 'choice': {
      const value = typeof setting.value === 'string' ? setting.value : '';
      const known = control.options.some((option) => option.value === value);
      body = (
        <>
          <Label htmlFor={id} mark={mark}>
            {setting.label}
          </Label>
          <select
            id={id}
            className="select rules-form-select"
            aria-describedby={describedBy}
            aria-invalid={common.invalid || undefined}
            value={value}
            onChange={(event) => {
              set(event.target.value === '' ? undefined : event.target.value);
            }}
          >
            <option value="">{control.unset}</option>
            {control.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            {!known && value !== '' ? (
              <option value={value}>“{value}”, which the format does not take</option>
            ) : null}
          </select>
        </>
      );
      break;
    }
    case 'yesNo':
      body = (
        <>
          <Label htmlFor={id} mark={mark}>
            {setting.label}
          </Label>
          <select
            id={id}
            className="select rules-form-select"
            aria-describedby={describedBy}
            aria-invalid={common.invalid || undefined}
            value={setting.value === true ? 'yes' : setting.value === false ? 'no' : ''}
            onChange={(event) => {
              const chosen = event.target.value;
              set(chosen === 'yes' ? true : chosen === 'no' ? false : undefined);
            }}
          >
            <option value="">{control.unset}</option>
            <option value="yes">{control.yes}</option>
            <option value="no">{control.no}</option>
          </select>
        </>
      );
      break;
    case 'list':
      body = (
        <ListInput
          label={setting.label}
          mark={mark}
          describedBy={describedBy}
          value={setting.value}
          add={control.add}
          placeholder={control.placeholder}
          set={set}
        />
      );
      break;
    case 'text': {
      const value = typeof setting.value === 'string' ? setting.value : '';
      const change = (words: string) => {
        set(words === '' && !control.required ? undefined : words);
      };
      body = (
        <>
          <Label htmlFor={id} mark={mark}>
            {setting.label}
          </Label>
          {control.lines ? (
            <textarea
              id={id}
              className="text-input rules-form-text"
              rows={3}
              aria-describedby={describedBy}
              aria-invalid={common.invalid || undefined}
              value={value}
              onChange={(event) => {
                change(event.target.value);
              }}
            />
          ) : (
            <input
              id={id}
              className="text-input"
              aria-describedby={describedBy}
              aria-invalid={common.invalid || undefined}
              value={value}
              onChange={(event) => {
                change(event.target.value);
              }}
            />
          )}
        </>
      );
      break;
    }
    case 'licence':
      body = (
        <LicenceInput
          label={setting.label}
          mark={mark}
          describedBy={describedBy}
          unset={control.unset}
          value={setting.value}
          set={set}
        />
      );
      break;
  }
  return (
    <div
      className="rules-form-setting"
      data-testid="rules-form-setting"
      data-field={setting.field}
      data-changed={changed}
    >
      {body}
      {hint ? (
        <p id={hintId} className="muted small rules-form-hint">
          {hint}
        </p>
      ) : null}
      {problems.length > 0 ? (
        <ul id={problemId} className="rules-form-problems small" data-testid="rules-form-problem">
          {problems.map((problem) => (
            <li key={`${problem.field ?? ''}:${problem.words}`}>{problem.words}</li>
          ))}
        </ul>
      ) : null}
      {shipped?.changed ? (
        <p id={shippedId} className="small rules-form-shipped" data-testid="rules-form-shipped">
          <span>Shipped: {valueInWords(setting, shipped.shipped, WAY_NAMES)}</span>{' '}
          <button
            type="button"
            className="button button-small"
            data-testid="rules-form-put-back"
            aria-label={`Put back ${setting.label.toLowerCase()} as shipped`}
            onClick={() => {
              putBack(shipped);
            }}
          >
            Put back
          </button>
        </p>
      ) : null}
    </div>
  );
}

function Label({
  htmlFor,
  mark,
  children,
}: {
  htmlFor: string;
  mark: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rules-form-label">
      <label htmlFor={htmlFor}>{children}</label>
      {mark}
    </div>
  );
}

/**
 * The pause, in seconds, or another number (`whole`, such as a width in
 * pixels): what the person types is kept as typed while it is not a number
 * yet, and written to the file once it is one; empty takes it out of the
 * file, and what `unset` says holds (for the pause, the app's own minimum).
 */
function NumberInput({
  id,
  describedBy,
  invalid,
  value,
  min,
  max,
  disabled,
  set,
  whole = false,
  unit = 'seconds',
  unset = 'Not set: the app’s own minimum',
}: {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  value: unknown;
  min: number;
  max: number;
  disabled: boolean;
  set: (value: unknown) => void;
  /** A whole number (a width in pixels), not seconds that may have a fraction. */
  whole?: boolean;
  /** What the number counts, and what holds without one. */
  unit?: string;
  unset?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (typeof value === 'number' ? String(value) : '');
  return (
    <div className="rules-form-pause">
      <input
        id={id}
        className="text-input"
        type="number"
        inputMode={whole ? 'numeric' : 'decimal'}
        min={min}
        max={max}
        step={whole ? 1 : 'any'}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        data-testid={whole ? 'rules-form-number' : 'rules-form-pause'}
        value={shown}
        onChange={(event) => {
          const typed = event.target.value;
          setDraft(typed);
          if (typed.trim() === '') set(undefined);
          else {
            const number = Number(typed);
            if (Number.isFinite(number)) set(number);
          }
        }}
        onBlur={() => {
          setDraft(null);
        }}
      />
      <span className="muted small">{typeof value === 'number' ? unit : unset}</span>
    </div>
  );
}

/** A list of words or hosts: each entry can be changed or removed, and one added. */
function ListInput({
  label,
  mark,
  describedBy,
  value,
  add,
  placeholder,
  set,
}: {
  label: string;
  mark: React.ReactNode;
  describedBy: string | undefined;
  value: unknown;
  add: string;
  placeholder: string;
  set: (value: unknown) => void;
}) {
  const [adding, setAdding] = useState('');
  const addId = useId();
  const entries = Array.isArray(value) ? value.map((entry) => String(entry)) : [];
  const write = (next: string[]) => {
    set(next.length > 0 ? next : undefined);
  };
  const addOne = () => {
    const words = adding.trim();
    if (!words) return;
    write([...entries, words]);
    setAdding('');
  };
  return (
    <fieldset className="rules-form-choices" aria-describedby={describedBy}>
      <legend className="rules-form-label">
        {label} {mark}
      </legend>
      {entries.length > 0 ? (
        <ul className="rules-form-list">
          {entries.map((entry, index) => (
            <li key={index}>
              <input
                className="text-input"
                aria-label={`${label}, entry ${index + 1}`}
                value={entry}
                onChange={(event) => {
                  write(entries.map((one, i) => (i === index ? event.target.value : one)));
                }}
              />
              <button
                type="button"
                className="button button-small"
                aria-label={`Remove ${entry || `entry ${index + 1}`}`}
                onClick={() => {
                  write(entries.filter((_, i) => i !== index));
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small rules-form-none">None.</p>
      )}
      <div className="rules-form-add">
        <label htmlFor={addId} className="visually-hidden">
          {add}
        </label>
        <input
          id={addId}
          className="text-input"
          placeholder={placeholder}
          value={adding}
          onChange={(event) => {
            setAdding(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addOne();
            }
          }}
        />
        <button
          type="button"
          className="button button-small"
          disabled={adding.trim() === ''}
          onClick={addOne}
        >
          {add}
        </button>
      </div>
    </fieldset>
  );
}

/**
 * The licence block in its five forms, as the format names them, with the
 * words of the importer's licence step: a known licence from the list, or
 * the words filled in, and the name to credit for every form.
 */
function LicenceInput({
  label,
  mark,
  describedBy,
  unset,
  value,
  set,
}: {
  label: string;
  mark: React.ReactNode;
  describedBy: string | undefined;
  unset: string;
  value: unknown;
  set: (value: unknown) => void;
}) {
  const ids = useId();
  const form = value === undefined ? null : licenceFormIn(value);
  const block =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const words = (key: string) => (typeof block[key] === 'string' ? block[key] : '');
  const field = (key: string, title: string, type = 'text', lines = false) => (
    <>
      <label className="field-label" htmlFor={`${ids}-${key}`}>
        {title}
      </label>
      {lines ? (
        <textarea
          id={`${ids}-${key}`}
          className="text-input"
          rows={2}
          value={words(key)}
          onChange={(event) => {
            set(licenceWith(value, key, event.target.value));
          }}
        />
      ) : (
        <input
          id={`${ids}-${key}`}
          className="text-input"
          type={type}
          {...(type === 'url' ? { placeholder: 'https://' } : {})}
          value={words(key)}
          onChange={(event) => {
            set(licenceWith(value, key, event.target.value));
          }}
        />
      )}
    </>
  );
  const choose = (next: LicenceBlockForm | null) => {
    set(licenceInForm(value, next));
  };
  return (
    <fieldset
      className="rules-form-choices rules-form-licence"
      aria-describedby={describedBy}
      data-testid="rules-form-licence"
      data-form={form ?? (value === undefined ? 'unset' : 'other')}
    >
      <legend className="rules-form-label">
        {label} {mark}
      </legend>
      <div className="follow-links-options">
        <label className="follow-links-option">
          <input
            type="radio"
            name={`${ids}-form`}
            checked={value === undefined}
            onChange={() => {
              choose(null);
            }}
          />
          <span>
            <strong>{unset}</strong>
          </span>
        </label>
        {LICENCE_FORM_CHOICES.map((option) => (
          <label key={option} className="follow-links-option">
            <input
              type="radio"
              name={`${ids}-form`}
              value={option}
              checked={form === option}
              onChange={() => {
                choose(option);
              }}
            />
            <span>
              <strong>{LICENCE_FORM_WORDS[option].label}</strong>
              <span className="muted small">{LICENCE_FORM_WORDS[option].says}</span>
            </span>
          </label>
        ))}
      </div>
      {value !== undefined && form === null ? (
        <p className="small">
          The licence block is not in one of these forms. Choose one, or put it right in the JSON
          view.
        </p>
      ) : null}
      {form === 'known' ? (
        <div className="licence-fields">
          <label className="field-label" htmlFor={`${ids}-known`}>
            Licence
          </label>
          <select
            id={`${ids}-known`}
            className="select"
            value={words('known')}
            onChange={(event) => {
              set(licenceWith(value, 'known', event.target.value));
            }}
          >
            <option value="">Choose one…</option>
            {KNOWN_LICENCES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {form === 'permission' ? (
        <div className="licence-fields">
          {field('permission', LICENCE_FIELD_LABELS.words)}
          {field('from', LICENCE_FIELD_LABELS.givenBy)}
          {field('on', LICENCE_FIELD_LABELS.givenOn, 'date')}
          {field('address', LICENCE_FIELD_LABELS.terms, 'url')}
          {field('note', LICENCE_FIELD_LABELS.note, 'text', true)}
        </div>
      ) : null}
      {form !== null ? (
        <div className="licence-fields">
          {field(
            'credit',
            'The name to credit under each page, when it is not the site’s (optional)',
          )}
        </div>
      ) : null}
    </fieldset>
  );
}
