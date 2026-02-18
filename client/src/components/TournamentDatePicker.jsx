import { useEffect, useMemo, useRef, useState } from "react";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const formatUsDate = (date) => {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const year = date.getFullYear();
  return `${month}-${day}-${year}`;
};

const parseUsDate = (value) => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(trimmed);

  if (!match) {
    return null;
  }

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);

  if (!Number.isInteger(month) || !Number.isInteger(day) || !Number.isInteger(year)) {
    return null;
  }

  const parsed = new Date(year, month - 1, day);

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getFullYear() !== year ||
    parsed.getMonth() + 1 !== month ||
    parsed.getDate() !== day
  ) {
    return null;
  }

  return parsed;
};

const formatDisplayDate = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  const parsed = parseUsDate(value);

  if (!parsed) {
    return "";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsed);
};

function TournamentDatePicker({
  id,
  value,
  onChange,
  required = false,
  disabled = false,
}) {
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const todayUs = useMemo(() => formatUsDate(new Date()), []);
  const parsedValueDate = useMemo(() => parseUsDate(value), [value]);
  const [isOpen, setIsOpen] = useState(false);
  const [viewDate, setViewDate] = useState(() =>
    parsedValueDate ? new Date(parsedValueDate.getFullYear(), parsedValueDate.getMonth(), 1) : new Date()
  );

  useEffect(() => {
    if (!parsedValueDate) {
      return;
    }

    setViewDate(new Date(parsedValueDate.getFullYear(), parsedValueDate.getMonth(), 1));
  }, [parsedValueDate]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (!rootRef.current || rootRef.current.contains(event.target)) {
        return;
      }

      setIsOpen(false);
    };

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const monthLabel = new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
  }).format(viewDate);
  const firstWeekdayIndex = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leadingBlanks = Array.from({ length: firstWeekdayIndex }, (_, index) => index);
  const monthDays = Array.from({ length: daysInMonth }, (_, index) => index + 1);

  const selectDate = (nextValue) => {
    onChange?.(nextValue);
    setIsOpen(false);
    inputRef.current?.focus();
  };

  const moveMonth = (offset) => {
    setViewDate((previous) => new Date(previous.getFullYear(), previous.getMonth() + offset, 1));
  };

  return (
    <div className="tournament-date-picker" ref={rootRef}>
      <div className="tournament-date-input-wrap">
        <input
          ref={inputRef}
          id={id}
          type="text"
          required={required}
          disabled={disabled}
          placeholder="MM-DD-YYYY"
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          autoComplete="off"
        />
        <button
          type="button"
          className="tournament-date-trigger"
          onClick={() => {
            if (disabled) {
              return;
            }
            setIsOpen((previous) => !previous);
          }}
          disabled={disabled}
          aria-label="Open calendar"
        >
          <svg
            className="tournament-date-trigger-icon"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <rect x="3.5" y="5.5" width="17" height="15" rx="2.5" />
            <path d="M3.5 9.5H20.5" />
            <path d="M8 3.5V7" />
            <path d="M16 3.5V7" />
            <path d="M8 13H10.5" />
            <path d="M13.5 13H16" />
            <path d="M8 16.5H10.5" />
            <path d="M13.5 16.5H16" />
          </svg>
        </button>
      </div>
      <p className="tournament-date-display subtle">
        {formatDisplayDate(value) || "Select a tournament date"}
      </p>

      {isOpen && (
        <div className="tournament-date-popover" role="dialog" aria-label="Tournament date picker">
          <div className="tournament-date-popover-header">
            <button
              type="button"
              className="ghost-button tournament-date-nav"
              onClick={() => moveMonth(-1)}
            >
              Prev
            </button>
            <strong>{monthLabel}</strong>
            <button
              type="button"
              className="ghost-button tournament-date-nav"
              onClick={() => moveMonth(1)}
            >
              Next
            </button>
          </div>

          <div className="tournament-date-weekdays">
            {WEEKDAY_LABELS.map((weekday) => (
              <span key={weekday}>{weekday}</span>
            ))}
          </div>

          <div className="tournament-date-grid">
            {leadingBlanks.map((blank) => (
              <span key={`blank-${blank}`} className="tournament-date-grid-empty" aria-hidden="true" />
            ))}
            {monthDays.map((day) => {
              const date = new Date(year, month, day);
              const usDate = formatUsDate(date);
              const isSelected = usDate === value;
              const isToday = usDate === todayUs;

              return (
                <button
                  key={usDate}
                  type="button"
                  className={`tournament-date-day ${isSelected ? "is-selected" : ""} ${
                    isToday ? "is-today" : ""
                  }`.trim()}
                  onClick={() => selectDate(usDate)}
                >
                  {day}
                </button>
              );
            })}
          </div>

          <div className="tournament-date-popover-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => selectDate(todayUs)}
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default TournamentDatePicker;
