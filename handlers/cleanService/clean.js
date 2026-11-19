'use strict';
// ch-step-log-clean/cleanService.clean: {text} -> {steps, totalLines, kept}.
const {cleanLog} = require('../../lib/clean');

module.exports = async (input, ctx) => {
  const text = input != null ? input.text : null;
  if (typeof text !== 'string') throw ctx.error('INPUT_REJECTED', 'text must be a string: one job log');
  return {output: cleanLog(text)};
};
