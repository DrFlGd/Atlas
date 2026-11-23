import { useEffect, useId, useState } from 'react';
import { numberFormat } from '../state/derived';
import {
  buildGameMaps,
  chooseGameKind,
  closeGameFiles,
  gameFilesChoices,
  openGameFilesGame,
  pickGameFolder,
  setPersonalUse,
  startGameFiles,
  stopGameBuild,
  tickGameMap,
  tickGameMaps,
  useGameFiles,
  type GameFilesStep,
} from '../state/gameFiles';
import { showLibraryAdd } from '../state/libraryView';
import { UiIcon } from './icons';

/**
 * "Make a 3D map from game files" (see `state/gameFiles.ts`): the button
 * under the address box, and the steps on the right of the Library.
 */

/** The button that starts the steps, when an importer of this app reads a game's files. */
export function GameFilesButton() {
  const [offered, setOffered] = useState(false);
  useEffect(() => {
    let live = true;
    gameFilesChoices().then(
      (choices) => {
        if (live) setOffered(choices.length > 0);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  if (!offered) return null;
  return (
    <div className="library-browse">
      <button
        type="button"
        className="library-button-row"
        data-testid="game-files-start"
        onClick={() => {
          showLibraryAdd();
          void startGameFiles();
        }}
      >
        <UiIcon name="map" size={18} />
        <span>
          Make a 3D map from game files
          <span className="library-button-note">
            From a game you own, installed on this computer: its levels become 3D maps with their
            textures. Nothing is downloaded or sent anywhere.
          </span>
        </span>
      </button>
    </div>
  );
}

/** The steps, on the right of the Library, while they are under way. */
export function GameFilesFlow() {
  const step = useGameFiles((s) => s.step);
  if (step.kind === 'off') return null;
  return (
    <section className="dialog-section" data-testid="game-files" data-step={step.kind}>
      <h3>Make a 3D map from game files</h3>
      {step.kind === 'choose' ? <ChooseKind step={step} /> : null}
      {step.kind === 'folder' ? <ChooseFolder step={step} /> : null}
      {step.kind === 'maps' ? <ChooseMaps step={step} /> : null}
      {step.kind === 'building' ? <Building step={step} /> : null}
      {step.kind === 'done' ? <Done step={step} /> : null}
      {step.kind === 'failed' ? (
        <>
          <p className="download-error" role="alert" data-testid="game-files-error">
            {step.message}
          </p>
          <div className="row-actions">
            <button type="button" className="button" onClick={() => void startGameFiles()}>
              Start again
            </button>
            <button type="button" className="button" onClick={closeGameFiles}>
              Close
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

function ChooseKind({ step }: { step: Extract<GameFilesStep, { kind: 'choose' }> }) {
  if (step.choices.length === 0) {
    return <p className="muted">No importer of this app reads game files.</p>;
  }
  return (
    <>
      <p>Which kind of game is it?</p>
      <ul className="add-map-pick-list" data-testid="game-files-kinds">
        {step.choices.map((choice) => (
          <li key={`${choice.importerId}/${choice.kind.id}`}>
            <button
              type="button"
              className="library-button-row"
              data-testid="game-files-kind"
              data-kind={choice.kind.id}
              onClick={() => {
                chooseGameKind(choice);
              }}
            >
              <span>
                {choice.kind.title}
                <span className="library-button-note">{choice.kind.description}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="row-actions">
        <button type="button" className="button" onClick={closeGameFiles}>
          Cancel
        </button>
      </div>
    </>
  );
}

function ChooseFolder({ step }: { step: Extract<GameFilesStep, { kind: 'folder' }> }) {
  return (
    <>
      <p>
        <strong>{step.choice.kind.title}.</strong> {step.choice.kind.description}
      </p>
      <p className="muted small">
        Choose the folder the game is installed in. This app only reads it: nothing in it is
        changed, and nothing is sent anywhere. Choosing your own installed game is how you say you
        own it.
      </p>
      {step.error ? (
        <p className="download-error" role="alert" data-testid="game-files-error">
          {step.error}
        </p>
      ) : null}
      <div className="row-actions">
        <button
          type="button"
          className="button button-primary"
          data-testid="game-files-pick"
          disabled={step.reading}
          onClick={() => void pickGameFolder()}
        >
          {step.reading ? 'Reading the folder…' : 'Choose the game’s folder…'}
        </button>
        <button type="button" className="button" disabled={step.reading} onClick={closeGameFiles}>
          Cancel
        </button>
      </div>
    </>
  );
}

function ChooseMaps({ step }: { step: Extract<GameFilesStep, { kind: 'maps' }> }) {
  const baseId = useId();
  const { survey, ticked } = step;
  const all = survey.maps.map((m) => m.id);
  const count = ticked.length;
  return (
    <>
      <p>
        <strong>{survey.game.title}</strong>, in {step.folder.name}:{' '}
        {numberFormat.format(survey.maps.length)} {survey.maps.length === 1 ? 'map' : 'maps'}. Tick
        the maps to make; each becomes a 3D map of the game, with a picture drawn from above.
      </p>
      {(survey.notes ?? []).map((note) => (
        <p key={note} className="download-note small">
          {note}
        </p>
      ))}
      <div className="row-actions">
        <button
          type="button"
          className="link-button"
          data-testid="game-files-tick-all"
          onClick={() => {
            tickGameMaps(all, true);
          }}
        >
          Tick all
        </button>
        <button
          type="button"
          className="link-button"
          onClick={() => {
            tickGameMaps(all, false);
          }}
        >
          Tick none
        </button>
      </div>
      <ul className="add-map-pick-list" data-testid="game-files-maps">
        {survey.maps.map((map, index) => {
          const id = `${baseId}-${map.id}`;
          const group = map.group && map.group !== survey.maps[index - 1]?.group;
          return (
            <li key={map.id} data-testid="game-files-map" data-map={map.id}>
              {group ? <span className="add-map-choice-group small">{map.group}</span> : null}
              <label htmlFor={id} className="checkbox-row">
                <input
                  id={id}
                  type="checkbox"
                  checked={ticked.includes(map.id)}
                  onChange={(event) => {
                    tickGameMap(map.id, event.target.checked);
                  }}
                />
                <span>{map.name}</span>
              </label>
              {map.name !== map.id ? <span className="muted small">{map.id}</span> : null}
            </li>
          );
        })}
      </ul>
      <div className="download-confirm" data-testid="game-files-licence">
        <p>
          <strong>For personal use.</strong> The maps are made from your own copy of the game and
          kept in this app’s maps folder on this computer. The game’s levels and textures belong to
          its makers: keep the maps for yourself.
        </p>
        <label className="checkbox-row">
          <input
            type="checkbox"
            data-testid="game-files-personal"
            checked={step.personal}
            onChange={(event) => {
              setPersonalUse(event.target.checked);
            }}
          />
          <span>I own this game, and the maps are for my personal use.</span>
        </label>
      </div>
      <div className="row-actions">
        <button
          type="button"
          className="button button-primary"
          data-testid="game-files-build"
          disabled={count === 0 || !step.personal}
          onClick={() => void buildGameMaps()}
        >
          {count === 0
            ? 'Make maps'
            : `Make ${numberFormat.format(count)} ${count === 1 ? 'map' : 'maps'}`}
        </button>
        <button type="button" className="button" onClick={closeGameFiles}>
          Cancel
        </button>
      </div>
    </>
  );
}

function Building({ step }: { step: Extract<GameFilesStep, { kind: 'building' }> }) {
  return (
    <div aria-busy="true" data-testid="game-files-building">
      <p>
        Making the maps of <strong>{step.game}</strong>: {numberFormat.format(step.done)} of{' '}
        {numberFormat.format(step.total)} done.
      </p>
      <progress max={step.total} value={step.done} />
      <p className="muted small" data-testid="game-files-progress">
        {step.text}
      </p>
      <div className="row-actions">
        <button
          type="button"
          className="button"
          data-testid="game-files-stop"
          disabled={step.stopping}
          onClick={stopGameBuild}
        >
          {step.stopping ? 'Stopping after this map…' : 'Stop'}
        </button>
      </div>
    </div>
  );
}

function Done({ step }: { step: Extract<GameFilesStep, { kind: 'done' }> }) {
  return (
    <div data-testid="game-files-done">
      <p>
        <strong>{step.game}</strong>: {numberFormat.format(step.maps)}{' '}
        {step.maps === 1 ? 'map was' : 'maps were'} made and saved.
      </p>
      {step.leftOut.length > 0 ? (
        <ul className="muted small">
          {step.leftOut.slice(0, 20).map((sentence) => (
            <li key={sentence}>{sentence}</li>
          ))}
        </ul>
      ) : null}
      <div className="row-actions">
        <button
          type="button"
          className="button button-primary"
          data-testid="game-files-open"
          onClick={() => void openGameFilesGame(step.packId).then(closeGameFiles)}
        >
          Open the game
        </button>
        <button type="button" className="button" onClick={closeGameFiles}>
          Done
        </button>
      </div>
    </div>
  );
}
