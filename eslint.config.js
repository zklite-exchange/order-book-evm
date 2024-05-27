// @ts-check

import eslint from '@eslint/js';
import tsEslint from 'typescript-eslint';

export default tsEslint.config(
    eslint.configs.recommended,
    ...tsEslint.configs.recommended,
    {
        rules: {
            "semi": "off",
            "@typescript-eslint/semi": "error",
            "@typescript-eslint/no-explicit-any": "off"
        }
    }
);