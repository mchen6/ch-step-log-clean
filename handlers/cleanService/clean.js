'use strict';
// ch-step-log-clean/cleanService.clean: {text} -> {steps, totalLines, kept}.
const {cleanLog} = require('../../lib/clean');

module.exports = async (input) => {
  const text = input != null ? input.text : null;
  if (typeof text !== 'string') throw new DeviceError('ARGUMENTS_INVALID', 'text must be a string: one job log');
  return {output: cleanLog(text)};
};
