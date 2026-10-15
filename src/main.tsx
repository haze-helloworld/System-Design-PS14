import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './index.css';
import { App } from './ui/App';
createRoot(document.getElementById('root')!).render(<App />);
