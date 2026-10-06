// ESLint flat config — expo lint runs NON-interactively because eslint and
// eslint-config-expo are both installed as devDependencies (no install prompt).
// Note: the package's default entry is classic eslintrc format; the flat config
// array lives at eslint-config-expo/flat.js (explicit .js needed for ESM import).
import expoFlat from 'eslint-config-expo/flat.js';

export default [...expoFlat];
