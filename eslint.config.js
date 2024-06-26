/* eslint-disable */

const eslint = require('@eslint/js');
const tsEslint = require('typescript-eslint');

module.exports = tsEslint.config(
    eslint.configs.recommended,
    ...tsEslint.configs.recommended,
    {
        rules: {
            "semi": "off",
            "quotes": "off",
            "@typescript-eslint/quotes": "error",
            "@typescript-eslint/member-delimiter-style": "error",
            "@typescript-eslint/semi": "error",
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/ban-ts-comment": "off"
        },
    }
);
