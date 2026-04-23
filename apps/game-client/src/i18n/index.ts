import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import si from './si.json';

// No localStorage fallback — the operator passes ?lang= in the launch URL
// and App.tsx calls i18n.changeLanguage() after initialisation. English is
// the safe default for the first render.
i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    si: { translation: si },
  },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
