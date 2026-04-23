import ReactDOM from 'react-dom/client';
import { App } from './App';
import './i18n';
import './styles/variables.css';
import './styles/global.css';

// No BrowserRouter: this is a single-page iframe. The operator's casino
// is the "router" — we are one leaf they point at.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
