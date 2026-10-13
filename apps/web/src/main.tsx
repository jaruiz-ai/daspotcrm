import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// While the on-screen keyboard is up, hide the bottom bars so they can't float over the field being typed in.
const isTextField = (el: EventTarget | null) =>
  el instanceof HTMLElement && el.matches('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=button]), textarea, [contenteditable]');
document.addEventListener('focusin', (e) => { if (isTextField(e.target)) document.body.classList.add('typing'); });
document.addEventListener('focusout', () => {
  // Moving focus from one field to the next shouldn't flash the bars back in.
  setTimeout(() => { if (!isTextField(document.activeElement)) document.body.classList.remove('typing'); }, 80);
});

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
