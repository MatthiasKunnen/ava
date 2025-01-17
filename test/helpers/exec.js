const path = require('path');

const test = require('@ava/test');
const execa = require('execa');
const defaultsDeep = require('lodash/defaultsDeep');
const replaceString = require('replace-string');

const cliPath = path.resolve(__dirname, '../../cli.js');
const ttySimulator = path.join(__dirname, './simulate-tty.js');

const normalizePosixPath = string => replaceString(string, '\\', '/');
const normalizePath = (root, file) => normalizePosixPath(path.posix.normalize(path.relative(root, file)));

const compareStatObjects = (a, b) => {
	if (a.file < b.file) {
		return -1;
	}

	if (a.file > b.file) {
		return 1;
	}

	if (a.title < b.title) {
		return -1;
	}

	return 1;
};

exports.cwd = (...paths) => path.join(path.dirname(test.meta.file), 'fixtures', ...paths);
exports.cleanOutput = string => string.replace(/^\W+/, '').replace(/\W+\n+$/g, '').trim();

const NO_FORWARD_PREFIX = Buffer.from('🤗', 'utf8');

const forwardErrorOutput = async from => {
	for await (const message of from) {
		if (NO_FORWARD_PREFIX.compare(message, 0, 4) !== 0) {
			process.stderr.write(message);
		}
	}
};

exports.fixture = async (args, options = {}) => {
	const cwd = options.cwd || exports.cwd();
	const running = execa.node(cliPath, args, defaultsDeep({
		env: {
			AVA_EMIT_RUN_STATUS_OVER_IPC: 'I\'ll find a payphone baby / Take some time to talk to you'
		},
		cwd,
		serialization: 'advanced',
		nodeOptions: ['--require', ttySimulator]
	}, options));

	// Besides buffering stderr, if this environment variable is set, also pipe
	// to stderr. This can be useful when debugging the tests.
	if (process.env.DEBUG_TEST_AVA) {
		// Running.stderr.pipe(process.stderr);
		forwardErrorOutput(running.stderr);
	}

	const errors = new WeakMap();
	const logs = new WeakMap();
	const stats = {
		failed: [],
		failedHooks: [],
		passed: [],
		sharedWorkerErrors: [],
		skipped: [],
		todo: [],
		uncaughtExceptions: [],
		getError(statObject) {
			return errors.get(statObject);
		},
		getLogs(statObject) {
			return logs.get(statObject);
		}
	};

	running.on('message', statusEvent => {
		switch (statusEvent.type) {
			case 'hook-failed': {
				const {title, testFile} = statusEvent;
				const statObject = {title, file: normalizePath(cwd, testFile)};
				errors.set(statObject, statusEvent.err);
				stats.failedHooks.push(statObject);
				break;
			}

			case 'selected-test': {
				if (statusEvent.skip) {
					const {title, testFile} = statusEvent;
					stats.skipped.push({title, file: normalizePath(cwd, testFile)});
				}

				if (statusEvent.todo) {
					const {title, testFile} = statusEvent;
					stats.todo.push({title, file: normalizePath(cwd, testFile)});
				}

				break;
			}

			case 'shared-worker-error': {
				const {message, name, stack} = statusEvent.err;
				stats.sharedWorkerErrors.push({message, name, stack});
				break;
			}

			case 'test-passed': {
				const {title, testFile} = statusEvent;
				const statObject = {title, file: normalizePath(cwd, testFile)};
				stats.passed.push(statObject);
				logs.set(statObject, statusEvent.logs);
				break;
			}

			case 'test-failed': {
				const {title, testFile} = statusEvent;
				const statObject = {title, file: normalizePath(cwd, testFile)};
				errors.set(statObject, statusEvent.err);
				stats.failed.push(statObject);
				logs.set(statObject, statusEvent.logs);
				break;
			}

			case 'uncaught-exception': {
				const {message, name, stack} = statusEvent.err;
				stats.uncaughtExceptions.push({message, name, stack});
				break;
			}

			default:
				break;
		}
	});

	try {
		return {
			stats,
			...await running
		};
	} catch (error) {
		throw Object.assign(error, {stats});
	} finally {
		stats.failed.sort(compareStatObjects);
		stats.failedHooks.sort(compareStatObjects);
		stats.passed.sort(compareStatObjects);
		stats.skipped.sort(compareStatObjects);
		stats.todo.sort(compareStatObjects);
	}
};
