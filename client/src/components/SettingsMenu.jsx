import { useEffect, useRef, useState } from "react";
import { MdClose, MdSettings } from "react-icons/md";
import { useSettings } from "../context/SettingsContext.jsx";

function SettingsMenu({ placement = "right" }) {
  const { shortcutsEnabled, setShortcutsEnabled } = useSettings();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const buttonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handleClick = (event) => {
      if (!wrapperRef.current) return;
      if (wrapperRef.current.contains(event.target)) return;
      setOpen(false);
    };
    const handleKey = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", handleClick);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleClick);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open && buttonRef.current) {
      buttonRef.current.blur();
    }
  }, [open]);

  const toggle = () => setOpen((prev) => !prev);

  return (
    <div
      className={`settings-menu settings-menu--${placement} ${open ? "is-open" : ""}`}
      ref={wrapperRef}
    >
      <button
        className="settings-trigger"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Open settings"
        onClick={toggle}
        ref={buttonRef}
      >
        {open ? <MdClose /> : <MdSettings />}
      </button>

      {open && (
        <div className="settings-popover" role="dialog" aria-label="Application settings">
          <div className="settings-popover-header">
            <span className="settings-popover-title">Settings</span>
          </div>
          <label className="settings-option">
            <input
              type="checkbox"
              checked={shortcutsEnabled}
              onChange={(event) => setShortcutsEnabled(event.target.checked)}
            />
            <div className="settings-option-body">
              <span className="settings-option-label">Enable keyboard shortcuts</span>
              <span className="settings-option-hint">Toggle score editing hotkeys.</span>
            </div>
          </label>
        </div>
      )}
    </div>
  );
}

export default SettingsMenu;
