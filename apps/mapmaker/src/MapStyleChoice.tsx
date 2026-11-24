import { MAP_STYLES, TEXTURES_NOTE, type MapStyleId } from './report';

/** "Map style": how the floors are drawn. The textured styles draw the game's own models in their textures (an
 * area whose models cannot be read is height shaded), or for a map made from a 3D model (`model`), the model's own
 * textures and colours. */
export function MapStyleChoice(props: {
  id: string;
  label: string;
  value: MapStyleId;
  disabled?: boolean;
  model?: boolean;
  onChange: (style: MapStyleId) => void;
}) {
  const model = props.model ?? false;
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
            {style.label}
          </option>
        ))}
      </select>
      <span id={`${props.id}-note`} className="small muted">
        {model
          ? 'Textured draws each floor from above in the model’s own textures and colours (height shaded when it has none). Colour by floor gives each floor its own colour, darker low and lighter high within it. The styles with outlines draw the walls and the edges of the walkable floor as clear lines.'
          : `Height shaded with outlines draws the walls and the edges of the walkable floor as clear lines. Colour by floor gives each floor its own colour, darker low and lighter high within it. Textured styles: ${TEXTURES_NOTE.toLowerCase()}.`}
      </span>
    </div>
  );
}
