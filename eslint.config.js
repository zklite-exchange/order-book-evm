/* eslint-disable */

const eslint = require('@eslint/js');
const tsEslint = require('typescript-eslint');

module.exports = tsEslint.config(
    eslint.configs.recommended,
    ...tsEslint.configs.recommended,
    {
        rules: {
            "semi": "off",
            "@typescript-eslint/member-delimiter-style": "error",
            "@typescript-eslint/semi": "error",
            "@typescript-eslint/no-explicit-any": "off"
        },
    }
);
