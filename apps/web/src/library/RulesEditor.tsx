import {
  type SiteMapTrial,
  type SiteTrial,
  type SiteTrialNeed,
  type SiteTrialPicture,
  type SiteTrialLayout,
  type SiteTrialUnmatched,
} from '@atlas/importer-api';
import { DEFAULT_PAGE_WIDTH, PAGE_WIDTH_PIXELS, type PageWidth } from '@atlas/schema';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { UiIcon } from '../components/icons';
import { renderGuideMarkdown, revealHiddenText, type GuidePicture } from '../markdown';
import { formatJson } from '../state/jsonText';
import {
  checkEditorText,
  closeRulesEditor,
  copyIdNote,
  copyNameOf,
  copySources,
  copyTextFor,
  fieldSpot,
  useRulesEditor,
  type EditorCheck,
  type EditorProblem,
  type ExamplePage,
  type RulesEditorStart,
} from '../state/rulesEditor';
import { hostOf, idFromName, idProblem } from '../state/rulesCopy';
import {
  RULES_TEMPLATES,
  examplesLeft,
  rulesTemplate,
  type RulesTemplateType,
} from '../state/rulesTemplates';
import {
  canonicalAddressOf,
  httpsAddress,
  isSavedDataFile,
  pickTrialPage,
  saveRulesText,
  savingOf,
  layoutInWords,
  SAVED_PAGE_LAYOUT_NOTE,
  trialInWords,
  trialRead,
  tryRulesOn,
  useSites,
  type SiteEntry,
} from '../state/siteRules';
import type { TrialLayoutOutcome } from '../state/trialLayout';
import { AddedFile } from './SiteSwitchOn';

/**
 * The rules file editor (see `state/rulesEditor.ts`): a modal window over
 * Settings, "Sites", with the file as JSON on the left and, on the right,
 * what the reader makes of an example page with the file as it stands. Side
 * by side where there is room, one above the other where there is not.
 *
 * The left side is a plain text box in a fixed-width face, with line
 * numbers, checked after a short pause: each problem is listed in words
 * under the text, marked at its line, and moves the cursor to its field
 * when pressed. Tab puts in two spaces; Esc, then Tab, leaves the box.
 *
 * The right side tries the file again after each change that passes the
 * check, on the example page chosen; while the file has problems it keeps
 * the last result and says it is from before the change. A page is only
 * ever handed to the reader as text: it is never shown or run. The page
 * text the reader keeps is shown as Atlas shows a guide, with no picture
 * loaded: each picture is a box of its size with its words.
 */

/** How long the editor waits after a change before it checks the text. */
const CHECK_PAUSE_MS = 400;

/**
 * The views of the right side. One for now: a view of the example page
 * itself, to pick a part of it for a field, can be added beside it later,
 * with tabs to switch between them.
 */
const RESULT_VIEWS = [{ id: 'result', name: 'What the reader makes of it' }] as const;

export function RulesEditor() {
  const start = useRulesEditor((s) => s.start);
  const opened = useRulesEditor((s) => s.opened);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  /** What Esc or "Close" does: set by the open editor, which knows whether it has changes. */
  const leaveRef = useRef<() => void>(closeRulesEditor);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (start && !dialog.open) dialog.showModal();
    if (!start && dialog.open) dialog.close();
  }, [start]);

  if (!__ATLAS_DOWNLOADS__) return null;
  return (
    <dialog
      ref={ref}
      className="dialog rules-editor-dialog"
      aria-labelledby={titleId}
      data-testid="rules-editor"
      onCancel={(event) => {
        event.preventDefault();
        leaveRef.current();
      }}
      onClose={() => {
        if (useRulesEditor.getState().start) closeRulesEditor();
      }}
    >
      {start ? (
        <EditorBody key={opened} start={start} titleId={titleId} leaveRef={leaveRef} />
      ) : null}
    </dialog>
  );
}

/** The editor's title: what it is open on. */
function titleOf(start: RulesEditorStart, name: string | null): string {
  if (name) return `Edit ${name}`;
  if (start.kind === 'copy') return `Copy of ${start.name}`;
  return 'New rules file';
}

/** What a new file was started from: a template (its type), or a copy of a file listed (its name). */
type Started = { from: 'template'; type: RulesTemplateType } | { from: 'copy'; name: string };

/** What the right side shows for one example page: the last trial of it. */
interface PageTrial {
  /** The text of the file it was tried with. */
  text: string;
  result: SiteTrial | null;
  /** How the app laid the page out for the importer, when it asked. */
  layout: TrialLayoutOutcome | null;
  problem: string | null;
}

/** The example pages the editor opens with: the page of "Try on a saved page…", if any. */
function startPages(start: RulesEditorStart): ExamplePage[] {
  if (start.kind === 'new' || !start.page) return [];
  const { name, text, data, address } = start.page;
  return [{ id: 1, name, text, data, address }];
}

function EditorBody({
  start,
  titleId,
  leaveRef,
}: {
  start: RulesEditorStart;
  titleId: string;
  leaveRef: React.RefObject<() => void>;
}) {
  const initial = start.kind === 'new' ? null : start.text;
  const [text, setText] = useState(initial ?? '');
  /** The text as last saved, or as opened; a change from it is not kept until saved. */
  const [baseline, setBaseline] = useState(initial ?? '');
  const [choosing, setChoosing] = useState(start.kind === 'new');
  /** What the editor is on: `start`, until the person starts again from another template. */
  const [origin, setOrigin] = useState<RulesEditorStart>(start);
  /** What a new file was started from, once it was. */
  const [started, setStarted] = useState<Started | null>(null);
  /** The person asked to start again from another template, and has typed text to lose. */
  const [restarting, setRestarting] = useState(false);
  /** The file of the person's being edited, by its name in the Sites folder. */
  const [editing, setEditing] = useState<string | null>(start.kind === 'own' ? start.name : null);
  const [check, setCheck] = useState<EditorCheck>(() => checkEditorText(initial ?? ''));
  const [pages, setPages] = useState<ExamplePage[]>(() => startPages(start));
  const [pageId, setPageId] = useState<number | null>(() => startPages(start)[0]?.id ?? null);
  const [trials, setTrials] = useState<Record<number, PageTrial>>({});
  const [pickProblem, setPickProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const nextPage = useRef(startPages(start).length + 1);
  const entries = useSites((s) => s.entries);
  const confirm = useSites((s) => s.confirm);

  const dirty = !choosing && text !== baseline;
  useEffect(() => {
    leaveRef.current = () => {
      if (dirty) setLeaving(true);
      else closeRulesEditor();
    };
  }, [dirty, leaveRef]);
  useEffect(() => {
    if (leaving) keepEditingRef.current?.focus();
  }, [leaving]);

  // The text is checked after a short pause in typing.
  useEffect(() => {
    if (check.text === text) return;
    const timer = setTimeout(() => {
      setCheck(checkEditorText(text));
    }, CHECK_PAUSE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [text, check.text]);

  const page = pages.find((p) => p.id === pageId) ?? null;
  const rules = check.rules;

  // The file is tried again on the page after each change that passes the check.
  useEffect(() => {
    if (!rules || !page || (!page.data && !page.address)) return;
    if (trials[page.id]?.text === check.text) return;
    const tried = check.text;
    void tryRulesOn(rules, {
      html: page.data ? '' : page.text,
      ...(page.data ? { data: page.text } : {}),
      address: page.address,
    }).then((outcome) => {
      setTrials((all) => ({
        ...all,
        [page.id]: {
          text: tried,
          result: 'result' in outcome ? outcome.result : null,
          layout: 'result' in outcome ? outcome.layout : null,
          problem: 'problem' in outcome ? outcome.problem : null,
        },
      }));
    });
  }, [rules, page, check.text, trials]);

  /** Moves the cursor to a place of the text, and the text there into view. */
  const goTo = (at: number, end = at) => {
    const box = textRef.current;
    if (!box) return;
    box.focus();
    box.setSelectionRange(at, end);
    const lineHeight = Number.parseFloat(getComputedStyle(box).lineHeight) || 18;
    const line = box.value.slice(0, at).split('\n').length;
    box.scrollTop = Math.max(0, (line - 1) * lineHeight - box.clientHeight / 3);
    box.dispatchEvent(new Event('scroll'));
  };
  const goToField = (field: string) => {
    const spot = fieldSpot(text, field);
    if (spot) goTo(spot.at, spot.end);
  };

  const addPage = async () => {
    setPickProblem(null);
    let picked: { name: string; text: string } | null;
    try {
      picked = await pickTrialPage();
    } catch (error) {
      setPickProblem(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!picked) return;
    const data = isSavedDataFile(picked.name);
    const added: ExamplePage = {
      id: nextPage.current++,
      name: picked.name,
      data,
      text: picked.text,
      address: data ? null : canonicalAddressOf(picked.text),
    };
    setPages((all) => [...all, added]);
    setPageId(added.id);
  };

  const removePage = (id: number) => {
    const rest = pages.filter((p) => p.id !== id);
    setPages(rest);
    setTrials(({ [id]: _gone, ...others }) => others);
    if (pageId === id) setPageId(rest.at(-1)?.id ?? null);
  };

  const setAddress = (id: number, address: string) => {
    setPages((all) => all.map((p) => (p.id === id ? { ...p, address } : p)));
    setTrials(({ [id]: _gone, ...others }) => others);
  };

  // What saving would do follows the Sites folder as it changes.
  const saving_ = rules && check.text === text ? savingOf(rules, editing, entries) : null;

  const save = async () => {
    const now = checkEditorText(text);
    setCheck(now);
    if (!now.rules) return;
    setSaving(true);
    setSaveProblem(null);
    const saved = await saveRulesText(text, editing);
    setSaving(false);
    if ('problem' in saved) {
      setSaveProblem(saved.problem);
      return;
    }
    setEditing(saved.name);
    setBaseline(text);
  };

  const title = titleOf(origin, editing);

  /** Starts the file again from a template or a copy: the example pages stay. */
  const startFrom = (fresh: string, from: Started) => {
    setText(fresh);
    // A template is all examples, to be changed before it is saved; a copy is ready to save.
    setBaseline(from.from === 'template' ? fresh : '');
    setCheck(checkEditorText(fresh));
    setStarted(from);
    setChoosing(false);
  };
  const startAgain = () => {
    setRestarting(false);
    setOrigin({ kind: 'new' });
    setEditing(null);
    setSaveProblem(null);
    setChoosing(true);
  };
  const problemLines = new Set(check.problems.map((p) => p.line));
  const noteLines = new Set(check.notes.map((p) => p.line));
  const trial = page ? (trials[page.id] ?? null) : null;

  return (
    <div className="rules-editor">
      <header className="dialog-head rules-editor-head">
        <h2 id={titleId} data-testid="rules-editor-title">
          {title}
        </h2>
        <span className="muted small rules-editor-state" data-testid="rules-editor-state">
          {choosing ? '' : dirty ? 'Changes not saved' : editing ? 'Saved' : ''}
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label="Close"
          data-testid="rules-editor-close"
          onClick={() => {
            leaveRef.current();
          }}
        >
          <UiIcon name="close" />
        </button>
      </header>

      {leaving ? (
        <div
          className="download-confirm rules-editor-leave"
          role="alertdialog"
          aria-label="Leave without saving?"
          data-testid="rules-editor-leave"
        >
          <p>
            <strong>Leave without saving?</strong> Your changes to this file are not kept.
          </p>
          <div className="row-actions wrap">
            <button
              type="button"
              className="button"
              data-testid="rules-editor-leave-yes"
              onClick={() => {
                closeRulesEditor();
              }}
            >
              Leave without saving
            </button>
            <button
              ref={keepEditingRef}
              type="button"
              className="button button-primary"
              data-testid="rules-editor-leave-no"
              onClick={() => {
                setLeaving(false);
              }}
            >
              Keep editing
            </button>
          </div>
        </div>
      ) : null}

      {restarting ? (
        <div
          className="download-confirm rules-editor-leave"
          role="alertdialog"
          aria-label="Start again from another template?"
          data-testid="rules-editor-restart-ask"
        >
          <p>
            <strong>Start again from another template?</strong> The text of this file as it stands
            is not kept. The example pages stay.
          </p>
          <div className="row-actions wrap">
            <button
              type="button"
              className="button"
              data-testid="rules-editor-restart-yes"
              onClick={startAgain}
            >
              Start again
            </button>
            <button
              type="button"
              className="button button-primary"
              data-testid="rules-editor-restart-no"
              onClick={() => {
                setRestarting(false);
              }}
            >
              Keep editing
            </button>
          </div>
        </div>
      ) : null}

      {choosing ? (
        <TemplateChoice
          entries={entries}
          onTemplate={(fresh, type) => {
            startFrom(fresh, { from: 'template', type });
          }}
          onCopy={(fresh, name) => {
            startFrom(fresh, { from: 'copy', name });
          }}
        />
      ) : (
        <>
          <div className="rules-editor-panes">
            <section className="rules-editor-pane" aria-labelledby={`${titleId}-file`}>
              <div className="rules-editor-pane-head">
                <h3 id={`${titleId}-file`}>The file</h3>
                <button
                  type="button"
                  className="button button-small"
                  data-testid="rules-editor-format"
                  disabled={formatJson(text) === null}
                  onClick={() => {
                    const laid = formatJson(text);
                    if (laid !== null && laid !== text) {
                      setText(laid);
                      setCheck(checkEditorText(laid));
                    }
                  }}
                >
                  Format
                </button>
                <button
                  type="button"
                  className="button button-small"
                  data-testid="rules-editor-restart"
                  onClick={() => {
                    // Typed text is asked about first; a file as opened or saved is not lost.
                    if (text !== baseline && text.trim() !== '') setRestarting(true);
                    else startAgain();
                  }}
                >
                  Start again from another template…
                </button>
              </div>
              <JsonText
                text={text}
                textRef={textRef}
                problemLines={problemLines}
                noteLines={noteLines}
                invalid={check.problems.length > 0}
                describedBy={`${titleId}-check`}
                onChange={setText}
              />
              <CheckList
                id={`${titleId}-check`}
                check={check}
                pending={check.text !== text}
                onGo={(problem) => {
                  goTo(problem.at, problem.end);
                }}
              />
              {started?.from === 'template' && rules ? (
                <ExampleNote type={started.type} rules={rules} onGo={goToField} />
              ) : null}
              {started?.from === 'copy' && !editing ? (
                <p className="muted small" data-testid="rules-editor-copied">
                  This file started from a copy of {started.name}, made for the site you named.
                  Saving keeps it as a new file of yours: {started.name} does not change. Try it on
                  pages saved from the new site, and change what that site does differently.
                </p>
              ) : null}
              {origin.kind === 'copy' && !editing ? (
                <p className="muted small" data-testid="rules-editor-copy">
                  This is a copy of the shipped file {origin.name} that comes with {origin.importer}
                  . Saving keeps it as a file of yours: the shipped file does not change. While your
                  copy is switched on, it is used in place of the shipped file.
                </p>
              ) : null}
            </section>

            <section
              className="rules-editor-pane rules-editor-result"
              aria-labelledby={`${titleId}-result`}
            >
              <div className="rules-editor-pane-head">
                <h3 id={`${titleId}-result`}>{RESULT_VIEWS[0].name}</h3>
              </div>
              <ExamplePages
                pages={pages}
                page={page}
                problem={pickProblem}
                onPick={(id) => {
                  setPageId(id);
                }}
                onAdd={() => void addPage()}
                onRemove={removePage}
                onAddress={setAddress}
              />
              <TrialPane
                page={page}
                check={check}
                pending={check.text !== text}
                trial={trial}
                running={
                  rules !== null &&
                  page !== null &&
                  (page.data || page.address !== null) &&
                  trial?.text !== check.text
                }
                onGoToField={goToField}
              />
            </section>
          </div>

          <footer className="rules-editor-foot">
            <SaveNotes
              fromTemplate={origin.kind === 'new' && started?.from !== 'copy'}
              saving={saving_}
              editing={editing}
              dirty={dirty}
            />
            {saveProblem ? (
              <p className="download-error" role="alert">
                {saveProblem}
              </p>
            ) : null}
            {confirm ? <AddedFile /> : null}
            <div className="row-actions wrap">
              <button
                type="button"
                className="button button-primary"
                data-testid="rules-editor-save"
                disabled={!saving_ || !dirty || saving}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                className="button"
                data-testid="rules-editor-done"
                onClick={() => {
                  leaveRef.current();
                }}
              >
                Close
              </button>
            </div>
          </footer>
        </>
      )}
    </div>
  );
}

/**
 * "New rules file…", and "Start again from another template…": an example
 * for each type of site, or a copy of any file listed (a shipped file or
 * one of the person's), made for the site the person names.
 */
function TemplateChoice({
  entries,
  onTemplate,
  onCopy,
}: {
  entries: readonly SiteEntry[];
  onTemplate: (text: string, type: RulesTemplateType) => void;
  onCopy: (text: string, from: string) => void;
}) {
  const [source, setSource] = useState<SiteEntry | null>(null);
  const sources = copySources(entries);
  if (source) {
    return (
      <CopyForm
        source={source}
        entries={entries}
        onBack={() => {
          setSource(null);
        }}
        onMade={(text) => {
          onCopy(text, source.name);
        }}
      />
    );
  }
  return (
    <div className="rules-editor-templates" data-testid="rules-editor-templates">
      <h3>An example for a type of site</h3>
      <p>
        What does the site hold? The new file starts from an example for it, with every value one
        you write the site’s own in place of. Nothing is saved until you press Save.
      </p>
      <p className="small" data-testid="rules-templates-change">
        Before a saved page shows, change the example’s host, its start address and page patterns,
        and where the title and text are (for a map: where its data and locations are) to the site’s
        own; a site that one of the importers’ own readers reads is often simpler to start from a
        copy of that reader’s file instead
        {sources.length > 0 ? ', listed under “A copy of a file”' : ''}.
      </p>
      <ul className="rules-template-list">
        {RULES_TEMPLATES.map((template) => (
          <li key={template.type}>
            <button
              type="button"
              className="button rules-template"
              data-testid={`rules-template-${template.type}`}
              onClick={() => {
                onTemplate(rulesTemplate(template.type), template.type);
              }}
            >
              <strong>{template.name}</strong>
              <span className="muted small">{template.about}</span>
            </button>
          </li>
        ))}
      </ul>
      {sources.length > 0 ? (
        <>
          <h3>A copy of a file</h3>
          <p>
            Is the site like one a file already reads? Start from a copy of that file, made for the
            new site: you give its name and address, and the copy keeps the rest. The file you copy
            does not change.
          </p>
          <ul className="rules-template-list" data-testid="rules-copy-sources">
            {sources.map((entry) => (
              <li key={entry.key}>
                <button
                  type="button"
                  className="button rules-template"
                  data-testid="rules-copy-source"
                  data-key={entry.key}
                  onClick={() => {
                    setSource(entry);
                  }}
                >
                  <strong>Start from a copy of {entry.title}</strong>
                  <span className="muted small">{entry.reads}</span>
                  <span className="muted small">
                    {entry.name}
                    {entry.own
                      ? ' · A file of yours'
                      : ` · Comes with ${entry.importer ?? 'an importer'}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/** The new site a copy is made for: its name, address, game and the file's id. */
function CopyForm({
  source,
  entries,
  onBack,
  onMade,
}: {
  source: SiteEntry;
  entries: readonly SiteEntry[];
  onBack: () => void;
  onMade: (text: string) => void;
}) {
  const formId = useId();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [game, setGame] = useState('');
  /** The id as the person typed it; null while it follows the name. */
  const [typedId, setTypedId] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [making, setMaking] = useState(false);
  const id = typedId ?? idFromName(name);
  const idNote = id && idProblem(id) === null ? copyIdNote(source, id, entries) : null;
  const refusal = source.refusal !== null;

  const make = async () => {
    const wrong: string[] = [];
    const siteName = name.trim();
    if (!siteName) wrong.push('Give the site’s name, as Atlas is to show it.');
    else if (siteName.length > 80) wrong.push('The site’s name must be at most 80 characters.');
    const host = hostOf(address);
    if ('problem' in host) wrong.push(host.problem);
    const idWhy = idProblem(id);
    if (idWhy) wrong.push(idWhy);
    if (game.trim().length > 80) wrong.push('The game’s name must be at most 80 characters.');
    setProblems(wrong);
    if (wrong.length > 0 || 'problem' in host) return;
    setMaking(true);
    const made = await copyTextFor(source, {
      name: siteName,
      host: host.host,
      id,
      ...(game.trim() && !refusal ? { game: game.trim() } : {}),
    });
    setMaking(false);
    if ('problems' in made) setProblems(made.problems);
    else onMade(made.text);
  };

  return (
    <form
      className="rules-editor-templates rules-copy-form"
      data-testid="rules-copy-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void make();
      }}
    >
      <h3>A copy of {source.title}, for another site</h3>
      <p className="muted small">{source.reads}</p>
      <p className="small" data-testid="rules-copy-what">
        {source.defaults
          ? `The copy is a file for the one site you name here, read by the same reader with the settings of these defaults. The defaults themselves do not change, and still count for every other site.`
          : refusal
            ? `The copy names the site you give here as one that is not read at all, with the same notice.`
            : `The copy keeps the parts of ${source.name}, with its addresses and hosts moved to the site you name here. What the file says of its own site (its notice, and who checked it) is left out.`}
      </p>
      <div className="rules-copy-fields">
        <label htmlFor={`${formId}-name`}>The site’s name</label>
        <input
          id={`${formId}-name`}
          className="text-input"
          data-testid="rules-copy-name"
          value={name}
          maxLength={80}
          onChange={(event) => {
            setName(event.target.value);
            setProblems([]);
          }}
        />
        <label htmlFor={`${formId}-host`}>Its address or host</label>
        <input
          id={`${formId}-host`}
          className="text-input"
          data-testid="rules-copy-host"
          inputMode="url"
          placeholder="wiki.example.org"
          value={address}
          onChange={(event) => {
            setAddress(event.target.value);
            setProblems([]);
          }}
        />
        {refusal ? null : (
          <>
            <label htmlFor={`${formId}-game`}>The game’s name, if the site is for one game</label>
            <input
              id={`${formId}-game`}
              className="text-input"
              data-testid="rules-copy-game"
              value={game}
              maxLength={80}
              onChange={(event) => {
                setGame(event.target.value);
                setProblems([]);
              }}
            />
          </>
        )}
        <label htmlFor={`${formId}-id`}>The file’s id</label>
        <input
          id={`${formId}-id`}
          className="text-input"
          data-testid="rules-copy-id"
          value={id}
          spellCheck={false}
          onChange={(event) => {
            setTypedId(event.target.value.trim().toLowerCase());
            setProblems([]);
          }}
        />
      </div>
      <p className="muted small" data-testid="rules-copy-name-note">
        {id
          ? `The id comes from the site’s name unless you change it. The copy is saved as ${copyNameOf(source, id)}.`
          : 'The id comes from the site’s name unless you change it.'}
      </p>
      {idNote ? (
        <p className="small rules-save-warn" data-testid="rules-copy-id-note">
          {idNote}
        </p>
      ) : null}
      {problems.length > 0 ? (
        <ul className="sites-problems" role="alert" data-testid="rules-copy-problems">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
      <div className="row-actions wrap">
        <button
          type="submit"
          className="button button-primary"
          data-testid="rules-copy-make"
          disabled={making}
        >
          {making ? 'Making the copy…' : 'Make the copy'}
        </button>
        <button type="button" className="button" data-testid="rules-copy-back" onClick={onBack}>
          Back
        </button>
      </div>
    </form>
  );
}

/**
 * The text box of the file: a fixed-width face, line numbers beside it with
 * a mark at each line that has a problem, and Tab putting in two spaces.
 * Esc, then Tab or Shift+Tab, moves out of it, as the hint under it says.
 */
function JsonText({
  text,
  textRef,
  problemLines,
  noteLines,
  invalid,
  describedBy,
  onChange,
}: {
  text: string;
  textRef: React.RefObject<HTMLTextAreaElement | null>;
  problemLines: ReadonlySet<number>;
  noteLines: ReadonlySet<number>;
  invalid: boolean;
  describedBy: string;
  onChange: (text: string) => void;
}) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const [released, setReleased] = useState(false);
  const hintId = useId();
  const lines = useMemo(() => text.split('\n').length, [text]);
  /** Puts in text at the selection as typing does, so that undo takes it back. */
  const type = (box: HTMLTextAreaElement, words: string) => {
    // Typed as the person would type it, so that undo takes it back; elsewhere, put in directly.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    if (!document.execCommand('insertText', false, words)) {
      box.setRangeText(words, box.selectionStart, box.selectionEnd, 'end');
      onChange(box.value);
    }
  };
  return (
    <div className="rules-json">
      <div className="rules-json-box">
        <div className="rules-json-gutter" ref={gutterRef} aria-hidden="true">
          {Array.from({ length: lines }, (_, i) => {
            const line = i + 1;
            const mark = problemLines.has(line) ? 'problem' : noteLines.has(line) ? 'note' : null;
            return (
              <div key={line} className="rules-json-line" data-mark={mark ?? undefined}>
                {line}
              </div>
            );
          })}
        </div>
        <textarea
          ref={textRef}
          className="rules-json-text"
          data-testid="rules-editor-text"
          aria-label="The rules file, as JSON"
          aria-describedby={`${hintId} ${describedBy}`}
          aria-invalid={invalid}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          wrap="off"
          value={text}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          onScroll={(event) => {
            if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
          }}
          onBlur={() => {
            setReleased(false);
          }}
          onKeyDown={(event) => {
            const box = event.currentTarget;
            if (event.key === 'Escape') {
              // Esc lets the next Tab leave the box; it does not close the editor.
              event.preventDefault();
              event.stopPropagation();
              setReleased(true);
              return;
            }
            if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) {
              if (released && event.key !== 'Shift') setReleased(false);
              return;
            }
            if (released) return;
            event.preventDefault();
            if (!event.shiftKey) {
              type(box, '  ');
              return;
            }
            // Shift+Tab takes up to two spaces off the start of the line.
            const lineStart = box.value.lastIndexOf('\n', box.selectionStart - 1) + 1;
            const spaces = /^ {1,2}/u.exec(box.value.slice(lineStart))?.[0].length ?? 0;
            if (spaces === 0) return;
            const caret = box.selectionStart;
            box.setSelectionRange(lineStart, lineStart + spaces);
            type(box, '');
            const back = Math.max(lineStart, caret - spaces);
            box.setSelectionRange(back, back);
          }}
        />
      </div>
      <p id={hintId} className="muted small rules-json-hint" aria-live="polite">
        {released
          ? 'Tab now moves out of the text.'
          : 'Tab puts in two spaces. To move out of the text with the keyboard, press Esc, then Tab.'}
      </p>
    </div>
  );
}

/** The problems of the text, each at its line, and what the importers say of a file whose form is right. */
function CheckList({
  id,
  check,
  pending,
  onGo,
}: {
  id: string;
  check: EditorCheck;
  pending: boolean;
  onGo: (problem: EditorProblem) => void;
}) {
  const list = (problems: readonly EditorProblem[], kind: 'problem' | 'note') => (
    <ul className={`rules-check-list rules-check-${kind}`} data-testid={`rules-editor-${kind}s`}>
      {problems.map((problem) => (
        <li key={`${problem.line}:${problem.words}`}>
          <button
            type="button"
            className="rules-check-item"
            data-field={problem.field ?? ''}
            onClick={() => {
              onGo(problem);
            }}
          >
            <span className="rules-check-line">Line {problem.line}</span>
            <span>{problem.words}</span>
          </button>
        </li>
      ))}
    </ul>
  );
  const count = check.problems.length;
  return (
    <div id={id} className="rules-check" data-testid="rules-editor-check">
      <p className="rules-check-summary" role="status">
        {pending
          ? 'Checking the file once you pause…'
          : count === 0
            ? 'The form of the file is right.'
            : count === 1
              ? 'The file has one problem. Press it to go to its field.'
              : `The file has ${count.toLocaleString('en')} problems. Press one to go to its field.`}
      </p>
      {count > 0 ? list(check.problems, 'problem') : null}
      {check.notes.length > 0 ? (
        <>
          <p className="muted small">What the importers say of it:</p>
          {list(check.notes, 'note')}
        </>
      ) : null}
    </div>
  );
}

/** The example pages: pick one, add one, remove one, and the address a page was saved from. */
function ExamplePages({
  pages,
  page,
  problem,
  onPick,
  onAdd,
  onRemove,
  onAddress,
}: {
  pages: readonly ExamplePage[];
  page: ExamplePage | null;
  problem: string | null;
  onPick: (id: number) => void;
  onAdd: () => void;
  onRemove: (id: number) => void;
  onAddress: (id: number, address: string) => void;
}) {
  const selectId = useId();
  return (
    <div className="rules-pages" data-testid="rules-editor-pages">
      <div className="row-actions wrap">
        {pages.length > 0 ? (
          <>
            <label htmlFor={selectId} className="rules-pages-label">
              Example page
            </label>
            <select
              id={selectId}
              className="select"
              data-testid="rules-editor-page"
              value={page?.id ?? ''}
              onChange={(event) => {
                onPick(Number(event.target.value));
              }}
            >
              {pages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <button
          type="button"
          className="button button-small"
          data-testid="rules-editor-add-page"
          onClick={onAdd}
        >
          Add a saved page…
        </button>
        {page ? (
          <button
            type="button"
            className="button button-small"
            data-testid="rules-editor-remove-page"
            onClick={() => {
              onRemove(page.id);
            }}
          >
            Remove this page
          </button>
        ) : null}
      </div>
      {problem ? (
        <p className="download-error" role="alert">
          {problem}
        </p>
      ) : null}
      {pages.length === 0 ? (
        <p className="muted small">
          Add a page you saved from the site (an .html file), or a map’s saved data file (a .json
          file), to see what the reader makes of it with the file as it stands. You can add several,
          such as the start page, an ordinary page and an unusual one, and switch between them. They
          are kept only while this file is open: nothing of them is saved or sent anywhere.
        </p>
      ) : null}
      {page && !page.data ? <PageAddress key={page.id} page={page} onAddress={onAddress} /> : null}
      {page?.data ? (
        <p className="muted small">
          A data file is tried at the start of the file’s map part, as the data of that map.
        </p>
      ) : null}
    </div>
  );
}

/** The address a page was saved from: its canonical link, or the one the person gives. */
function PageAddress({
  page,
  onAddress,
}: {
  page: ExamplePage;
  onAddress: (id: number, address: string) => void;
}) {
  const [given, setGiven] = useState(page.address ?? '');
  const [wrong, setWrong] = useState(false);
  const inputId = useId();
  return (
    <form
      className="sites-trial-address rules-page-address"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const address = httpsAddress(given);
        setWrong(!address);
        if (address) {
          setGiven(address);
          onAddress(page.id, address);
        }
      }}
    >
      <label htmlFor={inputId}>
        {page.address
          ? 'The page was saved from this address:'
          : 'The page does not say its own address. Which address was it saved from?'}
      </label>
      <div className="row-actions wrap">
        <input
          id={inputId}
          className="text-input"
          type="url"
          inputMode="url"
          placeholder="https://"
          data-testid="rules-editor-address"
          value={given}
          onChange={(event) => {
            setGiven(event.target.value);
          }}
        />
        <button
          type="submit"
          className="button button-small"
          data-testid="rules-editor-address-go"
          disabled={given.trim() === (page.address ?? '')}
        >
          {page.address ? 'Use this address' : 'Try it'}
        </button>
      </div>
      {wrong ? (
        <p className="small" role="alert">
          Give the whole address, starting with https://.
        </p>
      ) : null}
    </form>
  );
}

/** What the reader makes of the chosen page, or why there is nothing yet. */
function TrialPane({
  page,
  check,
  pending,
  trial,
  running,
  onGoToField,
}: {
  page: ExamplePage | null;
  check: EditorCheck;
  pending: boolean;
  trial: PageTrial | null;
  running: boolean;
  onGoToField: (field: string) => void;
}) {
  if (!page) return null;
  const waiting = !page.data && !page.address;
  const stale = trial !== null && trial.text !== check.text;
  let state: string | null = null;
  if (waiting) state = null;
  else if (running) state = 'Trying the file on the page…';
  else if (check.problems.length > 0 && !pending) {
    state = trial
      ? 'The file has problems, so this is what it read before your last change.'
      : 'The file has problems. Once its form is right, it is tried on the page.';
  } else if (stale || pending) state = 'The file changed: it is tried again once you pause.';
  return (
    <div className="rules-trial" data-testid="rules-editor-trial" data-stale={stale || pending}>
      <p className="muted small" role="status" data-testid="rules-editor-trial-state">
        {state ?? ''}
      </p>
      {trial?.problem ? (
        <p className="download-error" data-testid="rules-editor-trial-problem">
          {trial.problem}
        </p>
      ) : null}
      {trial?.result ? (
        <div className={stale ? 'rules-trial-result is-stale' : 'rules-trial-result'}>
          <TrialResult
            result={trial.result}
            layout={trial.layout}
            page={page}
            onGoToField={onGoToField}
          />
        </div>
      ) : null}
    </div>
  );
}

const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

/** One trial's result, shown as a view: the page as Atlas would keep it, or a map's data. */
function TrialResult({
  result,
  layout,
  page,
  onGoToField,
}: {
  result: SiteTrial;
  layout: TrialLayoutOutcome | null;
  page: ExamplePage;
  onGoToField: (field: string) => void;
}) {
  const lead = trialInWords(result, layout)[0];
  const unmatched = result.unmatched ?? [];
  const needs = result.needs ?? [];
  // The problems the list of what a page needs and of what matched nothing do not already say.
  const others = result.problems.filter(
    (problem) =>
      !needs.some((need) => need.says === problem) &&
      !unmatched.some((u) => problem.includes(u.value) && problem.includes('matched no')),
  );
  return (
    <div className="rules-result" data-testid="rules-editor-result">
      {lead ? <p data-testid="rules-result-lead">{lead}</p> : null}
      {!trialRead(result) ? (
        <>
          <p>
            {result.type === 'map' || page.data
              ? 'The file did not read the data.'
              : 'The file did not read the page.'}
          </p>
          {needs.length > 0 ? <TrialNeeds needs={needs} onGoToField={onGoToField} /> : null}
        </>
      ) : null}
      {trialRead(result) && needs.length > 0 ? (
        <TrialNeeds needs={needs} onGoToField={onGoToField} />
      ) : null}
      {!trialRead(result) ? null : result.map ? (
        <MapResult result={result} map={result.map} />
      ) : (
        <PageResult result={result} layout={layout} />
      )}
      <Unmatched unmatched={unmatched} onGoToField={onGoToField} />
      {others.length > 0 ? (
        <div className="rules-result-block">
          <h4>What else went wrong</h4>
          <ul className="sites-problems" data-testid="rules-result-problems">
            {others.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : unmatched.length === 0 && trialRead(result) ? (
        <p className="muted small">
          {result.map
            ? 'Every data path of the file matched in this data.'
            : 'Every selector of the file matched on this page.'}
        </p>
      ) : null}
    </div>
  );
}

/** How each state of a need is said. */
const NEED_STATES: Record<SiteTrialNeed['state'], string> = {
  done: 'Done',
  missing: 'Missing',
  unchecked: 'Not checked yet',
};

/**
 * What the page needs before the file reads it, in the order the importer
 * checks them, each with its state and what to change; a need that names
 * its field leads to it.
 */
function TrialNeeds({
  needs,
  onGoToField,
}: {
  needs: readonly SiteTrialNeed[];
  onGoToField: (field: string) => void;
}) {
  const missing = needs.filter((need) => need.state === 'missing').length;
  return (
    <div className="rules-result-block" data-testid="rules-result-needs">
      <h4>What the page needs</h4>
      <p className="muted small">
        {missing === 0
          ? 'The page has everything the file needs to read it.'
          : `Each is checked in this order. ${missing === 1 ? 'One is' : `${missing.toLocaleString('en')} are`} missing: change what it says, and the file is tried again.`}
      </p>
      <ol className="rules-needs">
        {needs.map((need) => (
          <li
            key={need.name}
            className="rules-need"
            data-state={need.state}
            data-testid="rules-result-need"
          >
            <span className="rules-need-state">{NEED_STATES[need.state]}</span>
            <span className="rules-need-name">{need.name}</span>
            <span className="rules-need-says">{need.says}</span>
            {need.field && need.state === 'missing' ? (
              <button
                type="button"
                className="link-button rules-need-go"
                data-field={need.field}
                onClick={() => {
                  onGoToField(need.field!);
                }}
              >
                Go to {need.field}
              </button>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Each selector or data path that matched nothing, with a way to its field. */
function Unmatched({
  unmatched,
  onGoToField,
}: {
  unmatched: readonly SiteTrialUnmatched[];
  onGoToField: (field: string) => void;
}) {
  if (unmatched.length === 0) return null;
  return (
    <div className="rules-result-block">
      <h4>Matched nothing</h4>
      <ul className="rules-check-list rules-check-problem" data-testid="rules-result-unmatched">
        {unmatched.map((entry) => (
          <li key={`${entry.field}:${entry.value}`}>
            <button
              type="button"
              className="rules-check-item"
              data-field={entry.field}
              onClick={() => {
                onGoToField(entry.field);
              }}
            >
              <span className="rules-check-line">{entry.field}</span>
              <code>{entry.value}</code>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A page of a wiki or guide, as the reader would keep it. */
function PageResult({ result, layout }: { result: SiteTrial; layout: TrialLayoutOutcome | null }) {
  const pictures = result.pictureList ?? [];
  const facts: [string, string][] = [
    ['Title', result.title ?? 'None found'],
    ...(result.game ? ([['Game', result.game]] as [string, string][]) : []),
    [
      'It has',
      `${count(result.headings, 'heading')}, ${count(result.pictures, 'picture')} and ${count(result.tables, 'table')}`,
    ],
    ...(result.credit ? ([['Credit line', result.credit]] as [string, string][]) : []),
    ...(result.licence ? ([['Licence', result.licence]] as [string, string][]) : []),
  ];
  return (
    <>
      <dl className="rules-result-facts" data-testid="rules-result-facts">
        {facts.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {result.notes && result.notes.length > 0 ? (
        <ul className="rules-result-list" data-testid="rules-result-notes">
          {result.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      <div className="rules-result-block">
        <h4>The page as Atlas would show it</h4>
        {result.page ? (
          <TrialPageText
            source={result.page}
            pictures={pictures}
            title={result.title}
            width={result.layout?.pageWidth ?? DEFAULT_PAGE_WIDTH}
            widthGiven={result.layout?.pageWidth !== undefined}
          />
        ) : result.text ? (
          <blockquote className="sites-trial-text" data-testid="rules-result-text">
            {result.text}
          </blockquote>
        ) : (
          <p className="muted small">The reader kept no text of this page.</p>
        )}
      </div>
      {result.layout ? <LayoutFound layout={result.layout} laidOut={layout} /> : null}
      {pictures.length > 0 ? <PictureList pictures={pictures} /> : null}
      {result.contents ? <ContentsList contents={result.contents} /> : null}
      <div className="rules-result-block" data-testid="rules-result-order">
        <h4>{result.chapters > 0 ? 'Chapters' : 'Next page'}</h4>
        {result.chapters > 0 ? (
          result.chapterTitles && result.chapterTitles.length > 0 ? (
            <ol className="rules-result-list">
              {result.chapterTitles.map((chapter, n) => (
                <li key={`${n}:${chapter}`}>{chapter}</li>
              ))}
            </ol>
          ) : (
            <p>It is split into {count(result.chapters, 'chapter')}.</p>
          )
        ) : null}
        {result.next ? (
          <p>
            {result.chapters > 0 ? 'The next page: ' : ''}
            <span className="path-inline">{result.next}</span>
          </p>
        ) : result.chapters === 0 ? (
          <p className="muted small">
            {result.type === 'guide' ? 'No next page was found.' : 'A wiki page has no next page.'}
          </p>
        ) : null}
      </div>
    </>
  );
}

/** The layout the reader found on the page, and what a saved page cannot show of it. */
function LayoutFound({
  layout,
  laidOut,
}: {
  layout: SiteTrialLayout;
  laidOut: TrialLayoutOutcome | null;
}) {
  const lines = layoutInWords(layout, laidOut);
  const said = lines.filter((line) => line !== SAVED_PAGE_LAYOUT_NOTE);
  return (
    <div className="rules-result-block" data-testid="rules-result-layout">
      <h4>Layout</h4>
      <ul className="rules-result-list">
        {said.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {said.length < lines.length ? (
        <p className="muted small" data-testid="rules-result-layout-note">
          {SAVED_PAGE_LAYOUT_NOTE}
        </p>
      ) : null}
    </div>
  );
}

/** The pictures of the page: what each shows, its size, and its addresses as text only. */
function PictureList({ pictures }: { pictures: readonly SiteTrialPicture[] }) {
  return (
    <div className="rules-result-block">
      <h4>Pictures</h4>
      <p className="muted small">Only their addresses are shown: no picture is loaded here.</p>
      <ol className="rules-result-list rules-result-pictures" data-testid="rules-result-pictures">
        {pictures.map((picture) => (
          <li key={picture.id}>
            <span>{picture.words || 'No words'}</span>
            {picture.width ? (
              <span className="muted small">
                {' '}
                · shown at {picture.width}
                {picture.height ? ` × ${picture.height}` : ''} pixels
              </span>
            ) : null}
            {picture.address ? (
              <span className="path-inline rules-result-address">{picture.address}</span>
            ) : null}
            {picture.full ? (
              <span className="muted small rules-result-address">
                Full size: <span className="path-inline">{picture.full}</span>
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The contents the page shows, under their groups, in their order. */
function ContentsList({ contents }: { contents: NonNullable<SiteTrial['contents']> }) {
  const groups: { name: string; entries: string[] }[] = [];
  for (const entry of contents.first) {
    const name = entry.group ?? '';
    const last = groups.at(-1);
    if (last?.name === name) last.entries.push(entry.title);
    else groups.push({ name, entries: [entry.title] });
  }
  return (
    <div className="rules-result-block" data-testid="rules-result-contents">
      <h4>Contents</h4>
      <p className="muted small">
        It lists {count(contents.count, 'page')}
        {contents.groups.length > 0 ? ` in ${count(contents.groups.length, 'group')}` : ''}
        {contents.first.length < contents.count
          ? `; the first ${contents.first.length.toLocaleString('en')} are here`
          : ''}
        .
      </p>
      {groups.map((group, n) => (
        <div key={`${n}:${group.name}`} className="rules-result-group">
          {group.name ? <p className="rules-result-group-name">{group.name}</p> : null}
          <ul className="rules-result-list">
            {group.entries.map((title, i) => (
              <li key={`${i}:${title}`}>{title}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** What a map part found in the data: its maps, types and first locations. */
function MapResult({ result, map }: { result: SiteTrial; map: SiteMapTrial }) {
  const { maps, types, locations } = map;
  const outside = maps.listed.reduce((sum, one) => sum + one.outside, 0);
  return (
    <>
      <dl className="rules-result-facts" data-testid="rules-result-facts">
        {result.game ? (
          <div>
            <dt>Game</dt>
            <dd>{result.game}</dd>
          </div>
        ) : null}
        <div>
          <dt>It has</dt>
          <dd>
            {count(maps.count, 'map')}, {count(types.count, 'type')} of location and{' '}
            {count(locations.count, 'location')}
          </dd>
        </div>
      </dl>
      <div className="rules-result-block">
        <h4>Maps</h4>
        <div className="rules-result-table-wrap">
          <table className="rules-result-table" data-testid="rules-result-maps">
            <thead>
              <tr>
                <th scope="col">Map</th>
                <th scope="col">Size in pixels</th>
                <th scope="col">Locations</th>
                <th scope="col">With a description</th>
                <th scope="col">With a link</th>
                <th scope="col">With a picture</th>
                <th scope="col">Outside it</th>
              </tr>
            </thead>
            <tbody>
              {maps.listed.map((one, n) => (
                <tr key={`${n}:${one.name}`}>
                  <th scope="row">
                    {one.name}
                    {one.group ? (
                      <span className="muted small"> · a floor of “{one.group}”</span>
                    ) : null}
                  </th>
                  <td>
                    {one.width.toLocaleString('en')} × {one.height.toLocaleString('en')}
                  </td>
                  <td>{one.locations.toLocaleString('en')}</td>
                  <td>{one.described.toLocaleString('en')}</td>
                  <td>{one.linked.toLocaleString('en')}</td>
                  <td>{one.pictured.toLocaleString('en')}</td>
                  <td>{one.outside.toLocaleString('en')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {maps.listed.length < maps.count ? (
          <p className="muted small">
            {count(maps.count - maps.listed.length, 'other map')} not listed here.
          </p>
        ) : null}
        <p className="muted small">
          {outside === 0
            ? 'Every position falls inside its map.'
            : 'Not every position falls inside its map: the table says how many fall outside.'}
        </p>
        {maps.listed.some((one) => one.image) ? (
          <ul className="rules-result-list">
            {maps.listed
              .filter((one) => one.image)
              .map((one, n) => (
                <li key={`${n}:${one.name}`}>
                  One image of “{one.name}”:{' '}
                  <span className="path-inline rules-result-address">{one.image}</span>
                </li>
              ))}
          </ul>
        ) : null}
      </div>
      <div className="rules-result-block" data-testid="rules-result-types">
        <h4>Types</h4>
        {types.first.length > 0 ? (
          <p>
            {types.first.length < types.count ? 'The first: ' : ''}
            {types.first.join(', ')}
          </p>
        ) : (
          <p className="muted small">No type was found.</p>
        )}
        {types.found ? (
          <dl className="rules-result-facts">
            <div>
              <dt>Can be ticked as found</dt>
              <dd>{types.found.can.length > 0 ? types.found.can.join(', ') : 'None'}</dd>
            </div>
            <div>
              <dt>Cannot</dt>
              <dd>{types.found.cannot.length > 0 ? types.found.cannot.join(', ') : 'None'}</dd>
            </div>
          </dl>
        ) : null}
        {types.found?.byName ? (
          <p className="muted small">
            The file does not say which (types.found), so the reader chose from each type’s name.
          </p>
        ) : null}
      </div>
      {locations.first.length > 0 ? (
        <div className="rules-result-block">
          <h4>The first locations</h4>
          <div className="rules-result-table-wrap">
            <table className="rules-result-table" data-testid="rules-result-locations">
              <thead>
                <tr>
                  <th scope="col">Location</th>
                  <th scope="col">Type</th>
                  <th scope="col">Map</th>
                  <th scope="col">Position</th>
                </tr>
              </thead>
              <tbody>
                {locations.first.map((one, n) => (
                  <tr key={`${n}:${one.name}`}>
                    <th scope="row">{one.name}</th>
                    <td>{one.type}</td>
                    <td>{one.map}</td>
                    <td>
                      {one.x.toLocaleString('en')}, {one.y.toLocaleString('en')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** Text safe in an SVG document. */
const xmlText = (text: string) => text.replace(/[<>&'"]/gu, (c) => `&#${c.charCodeAt(0)};`);

/** The size a picture is shown at here when the page gives none. */
const PLACEHOLDER = { width: 240, height: 135 };

/**
 * A picture of the page as a box of its size with its words, drawn here: an
 * image made of the text of an SVG document, so that nothing is loaded.
 */
function placeholderOf(picture: SiteTrialPicture | undefined, n: number): GuidePicture {
  const width = picture?.width ?? PLACEHOLDER.width;
  const height =
    picture?.height ?? (picture?.width ? Math.round(width * 0.5625) : PLACEHOLDER.height);
  const words = picture && picture.words !== '' ? picture.words : `Picture ${n}`;
  const size = picture?.width ? `${width} × ${height}` : 'Size not given';
  const room = Math.max(4, Math.floor(width / 7));
  const fits = (line: string) => (line.length > room ? `${line.slice(0, room - 1)}…` : line);
  const label =
    height >= 34
      ? `<text x="50%" y="${height / 2 - 4}" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#808a96">${xmlText(fits(words))}</text><text x="50%" y="${height / 2 + 12}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#808a96">${xmlText(fits(size))}</text>`
      : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="rgba(128,138,150,0.14)" stroke="#808a96" stroke-dasharray="4 3"/>${label}</svg>`;
  return { url: `data:image/svg+xml,${encodeURIComponent(svg)}`, width, height };
}

/** The frame's padding and border around the page's text column, in pixels. */
const SHEET_EDGES = 30;

/** The share of its size the page is drawn at, to fit `room` pixels, in steps of a hundredth. */
const fitScale = (room: number | null, pixels: number): number =>
  room && room > 0 && room < pixels ? Math.max(0.3, Math.floor((room / pixels) * 100) / 100) : 1;

/**
 * The page text as Atlas would show it, rendered as any guide is
 * (`renderGuideMarkdown`, which treats it as untrusted) with the styles of
 * a page of Guides, at the width the game's pages are shown at (`width`):
 * its layout forms (blocks side by side, cards, rows, columns) stand as
 * Guides sets them at that width, and the whole is drawn smaller to fit
 * the pane. Its pictures are boxes with their words; its links lead
 * nowhere from here.
 */
function TrialPageText({
  source,
  pictures,
  title,
  width,
  widthGiven,
}: {
  source: string;
  pictures: readonly SiteTrialPicture[];
  title: string | undefined;
  width: PageWidth;
  widthGiven: boolean;
}) {
  const roomRef = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<number | null>(null);
  useLayoutEffect(() => {
    const box = roomRef.current;
    if (!box) return;
    const measure = () => {
      setRoom(box.clientWidth);
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(box);
    return () => {
      watch.disconnect();
    };
  }, []);
  const pixels = PAGE_WIDTH_PIXELS[width];
  // The text column at the page's width, in its frame of the guide's colours.
  const scale = fitScale(room, pixels + SHEET_EDGES);
  const html = useMemo(() => {
    const byId = new Map(pictures.map((picture, n) => [picture.id, { picture, n: n + 1 }]));
    return renderGuideMarkdown(source, {
      picture: (id) => {
        const found = byId.get(id);
        return found ? placeholderOf(found.picture, found.n) : null;
      },
    });
  }, [source, pictures]);
  const inert = (event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('a')) event.preventDefault();
  };
  return (
    <>
      <p className="muted small" data-testid="rules-result-width">
        {widthGiven
          ? `Drawn as Guides draws it at the width of the game’s pages, ${PAGE_WIDTH_PIXELS[width].toLocaleString('en')} pixels`
          : `The file gives no width for the game’s pages, so this is drawn as Guides draws it at reading width, ${PAGE_WIDTH_PIXELS[width].toLocaleString('en')} pixels`}
        {scale < 1 ? `, at ${Math.round(scale * 100)}% of its size to fit here.` : '.'}
      </p>
      <div ref={roomRef} className="rules-trial-room">
        <div
          className="rules-trial-page"
          data-testid="rules-result-sheet"
          data-width={width}
          style={{ width: pixels, zoom: scale }}
        >
          {title ? <p className="rules-trial-page-title">{title}</p> : null}
          <div
            className="guide-body guides-page-body"
            data-testid="rules-result-page"
            onClickCapture={(event) => {
              inert(event);
              if (revealHiddenText(event.target, event.currentTarget)) event.preventDefault();
            }}
            onAuxClickCapture={inert}
            // markdown-it runs with raw HTML disabled, so this holds only renderer-made tags.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      </div>
    </>
  );
}

/**
 * While a file started from a template still holds the example's values
 * where a saved page needs the site's own: what to change first, and which
 * fields are still the example's, each leading to its field.
 */
function ExampleNote({
  type,
  rules,
  onGo,
}: {
  type: RulesTemplateType;
  rules: object;
  onGo: (field: string) => void;
}) {
  const left = examplesLeft(type, rules);
  const template = RULES_TEMPLATES.find((one) => one.type === type);
  if (left.length === 0 || !template) return null;
  return (
    <div className="small rules-example-note" data-testid="rules-editor-example">
      <p>{template.change}</p>
      <p className="muted">
        Still the example’s:{' '}
        {left.map((field, n) => (
          <span key={field}>
            {n > 0 ? ', ' : ''}
            <button
              type="button"
              className="link-button"
              data-field={field}
              onClick={() => {
                onGo(field);
              }}
            >
              {field}
            </button>
          </span>
        ))}
        .
      </p>
    </div>
  );
}

/** What saving does, said before the person saves. */
function SaveNotes({
  fromTemplate,
  saving,
  editing,
  dirty,
}: {
  /** A new file started from a template, whose values are all examples. */
  fromTemplate: boolean;
  saving: ReturnType<typeof savingOf> | null;
  editing: string | null;
  dirty: boolean;
}) {
  if (!saving) {
    return (
      <p className="muted small" data-testid="rules-editor-save-note">
        A file with problems cannot be saved. Once its form is right, Save keeps it in the Sites
        folder.
      </p>
    );
  }
  const notes: string[] = [];
  if (dirty || !editing) {
    notes.push(
      `It is saved as ${saving.name} in the Sites folder, switched off until you switch it on.`,
    );
  }
  if (saving.renamed) {
    notes.push(
      `Its name follows what it says, so it is saved as ${saving.name} in place of ${saving.renamed}, which is removed.`,
    );
  }
  if (saving.replaces) {
    notes.push(
      `A file of yours named ${saving.name} is already in the Sites folder: saving puts this file in its place.`,
    );
  }
  if (saving.on && dirty) {
    notes.push('This file is switched on. Saving switches it off until you switch it on again.');
  }
  if (fromTemplate && !editing && !dirty) {
    notes.push('Change the example values to the site’s own before you save.');
  }
  return (
    <div className="muted small" data-testid="rules-editor-save-note">
      {notes.map((note) => (
        <p
          key={note}
          className={note.startsWith('This file is switched on') ? 'rules-save-warn' : ''}
        >
          {note}
        </p>
      ))}
    </div>
  );
}
