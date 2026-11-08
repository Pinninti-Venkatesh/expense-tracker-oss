function emit(level, msg, extra) {
  const line = `[${new Date().toISOString()}] ${level} ${msg}`;
  if (extra === undefined) console.log(line);
  else console.log(line, typeof extra === 'string' ? extra : JSON.stringify(extra));
}

export default {
  info: (msg, extra) => emit('INFO', msg, extra),
  warn: (msg, extra) => emit('WARN', msg, extra),
  error: (msg, extra) => emit('ERROR', msg, extra),
  debug: (msg, extra) => {
    if (process.env.DEBUG) emit('DEBUG', msg, extra);
  },
};
