"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { GeoPlace } from "@/lib/geo/places";
import { useLocale } from "@/app/components/LocaleProvider";

type CityAutocompleteProps = {
  value: string;
  onChange: (value: string) => void;
  onSelect: (place: GeoPlace) => void;
  disabled?: boolean;
  name?: string;
  maxLength?: number;
  placeholder?: string;
  autoFocus?: boolean;
};

export default function CityAutocomplete({
  value,
  onChange,
  onSelect,
  disabled,
  name = "city",
  maxLength = 80,
  placeholder = "Brea, CA",
  autoFocus,
}: CityAutocompleteProps) {
  const { t, tx } = useLocale();
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [places, setPlaces] = useState<GeoPlace[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    const query = value.trim();
    if (query.length < 2) return;

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch(`/api/geo?q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("lookup failed");
          return (await response.json()) as { places?: GeoPlace[] };
        })
        .then((body) => {
          setPlaces(body.places ?? []);
          setActiveIndex(0);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setPlaces([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 220);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [open, value]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  function choose(place: GeoPlace) {
    onSelect(place);
    setOpen(false);
    setPlaces([]);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      if (value.trim().length >= 2) {
        setOpen(true);
        setLoading(true);
      }
      return;
    }
    if (!open || places.length === 0) {
      if (event.key === "Escape") setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % places.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + places.length) % places.length);
    } else if (event.key === "Enter") {
      const place = places[activeIndex];
      if (place) {
        event.preventDefault();
        choose(place);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  const showList =
    open && value.trim().length >= 2 && (loading || places.length > 0);

  return (
    <div className="city-autocomplete" ref={rootRef}>
      <input
        name={name}
        data-field="city"
        maxLength={maxLength}
        value={value}
        disabled={disabled}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        autoFocus={autoFocus}
        placeholder={placeholder}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={
          showList && places[activeIndex] ? `${listId}-${places[activeIndex].id}` : undefined
        }
        onFocus={() => {
          if (value.trim().length >= 2) {
            setOpen(true);
            setLoading(true);
          }
        }}
        onChange={(event) => {
          const nextValue = event.target.value;
          onChange(nextValue);
          setOpen(true);
          if (nextValue.trim().length < 2) {
            setPlaces([]);
            setLoading(false);
          } else {
            setLoading(true);
          }
        }}
        onKeyDown={onKeyDown}
      />
      {showList ? (
        <ul className="city-autocomplete-list" id={listId} role="listbox">
          {places.map((place, index) => (
            <li
              key={place.id}
              id={`${listId}-${place.id}`}
              role="option"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? "is-active" : undefined}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(place);
              }}
            >
              {tx(place.label)}
            </li>
          ))}
          {loading && places.length === 0 ? (
            <li className="city-autocomplete-status" role="presentation">
              {t("city.searchingUSCities")}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
