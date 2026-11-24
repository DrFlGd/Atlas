import { MAP_STYLES, TEXTURES_NOTE, type MapStyleId } from './report';

/** "Map style": how the floors are drawn. The textured styles are shown, and cannot be chosen yet. */
export function MapStyleChoice(props: {
  id: string;
  label: string;
  value: MapStyleId;
  disabled?: boolean;
  onChange: (style: MapStyleId) => void;
}) {
  return (
    <div className="mm-style">
      <label htmlFor={props.id}>{props.label}</label>
      <select
        id={props.id}
        value={props.value}
        disabled={props.disabled}
        aria-describedby={`${props.id}-note`}
        onChange={(event) => {
          props.onChange(event.target.value as MapStyleId);
        }}
      >
        {MAP_STYLES.map((style) => (
          <option key={style.id} value={style.id} disabled={!style.available}>
            {style.available ? style.label : `${style.label} (not yet)`}
          </option>
        ))}
      </select>
      <span id={`${props.id}-note`} className="small muted">
        Height shaded with outlines draws the walls and the edges of the walkable floor as clear
        lines. Colour by floor gives each floor its own colour, darker low and lighter high within
        it. Textured styles: {TEXTURES_NOTE.toLowerCase()}.
      </span>
    </div>
  );
}
