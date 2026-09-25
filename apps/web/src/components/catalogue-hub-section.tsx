import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";

const HUB_LETTERS = ["#", ..."abcdefghijklmnopqrstuvwxyz".split("")] as const;

export function HubLetterLane({
  buildHref,
  label,
  letters,
}: {
  buildHref: (page: number) => string;

  label: string;
  letters: { letter: string; page: number }[];
}) {
  if (letters.length === 0) {
    return undefined;
  }

  const pageByLetter = new Map(letters.map((entry) => [entry.letter, entry.page]));

  return (
    <nav aria-label={label} className="catalogue-letters">
      {HUB_LETTERS.map((letter) => {
        const display = letter === "#" ? "#" : letter.toUpperCase();
        const page = pageByLetter.get(letter);

        return page === undefined ? (
          <span aria-hidden="true" className="catalogue-letter catalogue-letter-empty" key={letter}>
            {display}
          </span>
        ) : (
          <a className="catalogue-letter" href={buildHref(page)} key={letter}>
            {display}
          </a>
        );
      })}
    </nav>
  );
}

export function laneScrollAffordances(metrics: {
  clientWidth: number;
  scrollLeft: number;
  scrollWidth: number;
}): { canScrollLeft: boolean; canScrollRight: boolean } {
  return {
    canScrollLeft: metrics.scrollLeft > 1,
    canScrollRight: metrics.scrollLeft + metrics.clientWidth < metrics.scrollWidth - 1,
  };
}

export function HubYearLane({
  buildHref,
  label,
  years,
}: {
  buildHref: (page: number) => string;

  label: string;
  years: { page: number; year: string }[];
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [affordances, setAffordances] = useState({ canScrollLeft: false, canScrollRight: false });

  const measure = useCallback(() => {
    const el = scrollerRef.current;

    if (el) {
      setAffordances(laneScrollAffordances(el));
    }
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;

    if (!el) {
      return;
    }

    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);

    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [measure]);

  if (years.length === 0) {
    return undefined;
  }

  const pageBy = (direction: -1 | 1) => {
    const el = scrollerRef.current;

    if (el) {
      el.scrollBy({ left: direction * el.clientWidth * 0.8 });
    }
  };

  return (
    <div className="hub-year-lane">
      <button
        aria-label="Scroll years left"
        className="hub-year-lane-caret"
        disabled={!affordances.canScrollLeft}
        onClick={() => pageBy(-1)}
        type="button"
      >
        <CaretLeftIcon aria-hidden="true" size={16} weight="bold" />
      </button>

      <nav aria-label={label} className="hub-year-lane-scroller" ref={scrollerRef}>
        {years.map((entry) => (
          <a className="catalogue-letter" href={buildHref(entry.page)} key={entry.year}>
            {entry.year}
          </a>
        ))}
      </nav>

      <button
        aria-label="Scroll years right"
        className="hub-year-lane-caret"
        disabled={!affordances.canScrollRight}
        onClick={() => pageBy(1)}
        type="button"
      >
        <CaretRightIcon aria-hidden="true" size={16} weight="bold" />
      </button>
    </div>
  );
}
