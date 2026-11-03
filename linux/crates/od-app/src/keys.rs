//! egui key -> KeyboardEvent.code, so the Serato keymap table (keyed on
//! physical codes) applies unchanged.
use egui::Key;

pub fn code(k: Key) -> Option<&'static str> {
    use Key::*;
    Some(match k {
        A => "KeyA", B => "KeyB", C => "KeyC", D => "KeyD", E => "KeyE", F => "KeyF", G => "KeyG", H => "KeyH", I => "KeyI", J => "KeyJ", K => "KeyK", L => "KeyL", M => "KeyM",
        N => "KeyN", O => "KeyO", P => "KeyP", Q => "KeyQ", R => "KeyR", S => "KeyS", T => "KeyT", U => "KeyU", V => "KeyV", W => "KeyW", X => "KeyX", Y => "KeyY", Z => "KeyZ",
        Num0 => "Digit0", Num1 => "Digit1", Num2 => "Digit2", Num3 => "Digit3", Num4 => "Digit4", Num5 => "Digit5", Num6 => "Digit6", Num7 => "Digit7", Num8 => "Digit8", Num9 => "Digit9",
        F1 => "F1", F2 => "F2", F3 => "F3", F4 => "F4", F5 => "F5", F6 => "F6", F7 => "F7", F8 => "F8", F9 => "F9", F10 => "F10", F11 => "F11", F12 => "F12",
        ArrowLeft => "ArrowLeft", ArrowRight => "ArrowRight", ArrowUp => "ArrowUp", ArrowDown => "ArrowDown",
        Space => "Space", Tab => "Tab", Escape => "Escape", Enter => "Enter", Delete => "Delete", Backspace => "Backspace",
        Equals | Plus => "Equal", Minus => "Minus", Backtick => "Backquote", Slash | Questionmark => "Slash", Backslash => "Backslash",
        Comma => "Comma", Period => "Period", Semicolon => "Semicolon", Quote => "Quote", OpenBracket => "BracketLeft", CloseBracket => "BracketRight",
        _ => return None,
    })
}
