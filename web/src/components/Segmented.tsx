import type { ReactNode } from "react";

/** A row of mutually exclusive choices drawn as one segmented control (radio buttons). */
export function Segmented<T extends string>(props: {
  readonly legend: string;
  /** The radio group's name, unique on the page. */
  readonly name: string;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}): ReactNode {
  return (
    <fieldset className="segmented">
      <legend className="visually-hidden">{props.legend}</legend>
      {props.options.map((option) => (
        <label key={option.value} className={props.value === option.value ? "selected" : undefined}>
          <input
            type="radio"
            name={props.name}
            value={option.value}
            checked={props.value === option.value}
            onChange={() => {
              props.onChange(option.value);
            }}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
