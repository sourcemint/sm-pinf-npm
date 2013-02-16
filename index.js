
const ASSERT = require("assert");
const PATH = require("path");
const URL = require("url");
const FS = require("fs-extra");
const DEEPMERGE = require("deepmerge");
// TODO: Make `jsonlint` optional (too many dependencies for what we get).
const JSONLINT = require("jsonlint");


var instances = {};

exports.forProgram = function(options) {
	if (typeof options === "string") {
		options = {
			CWD: options
		};
	}
	return function(module, ns) {
		return new PINF(options, module, ns);
	};
}

exports.for = exports.forProgram({
	CWD: process.cwd(),
	PINF_PROGRAM: process.env.PINF_PROGRAM,
	PINF_PACKAGE: process.env.PINF_PACKAGE,
	PINF_MODE: process.env.PINF_MODE
});


exports.uriToPath = function(uri) {
	return uri.replace(/[:@#]/g, "/").replace(/[\?&=]/g, "+").replace(/\/+/g, "/").replace(/\/$/, "+");
}

exports.uriToFilename = function(uri) {
	return exports.uriToPath(uri).replace(/\//g, "+");
}


var PINF = function(options, module, ns) {
	var self = this;

	self.ENV = {};
	for (var name in process.env) {
		self.ENV[name] = process.env[name];
	}
	// These environment variables declare what to boot and in which state:
	//   * A local filesystem path to a `program.json` file (how to boot).
	self.ENV.PINF_PROGRAM = options.PINF_PROGRAM || PATH.join(options.CWD, "program.json");
	//   * A local filesystem path to a `package.json` file (what to boot).
	self.ENV.PINF_PACKAGE = options.PINF_PACKAGE || PATH.join(options.CWD, "package.json");
	//   * A local filesystem path to a `program.rt.json` file (the state to boot in).
	self.ENV.PINF_RUNTIME = PATH.join(self.ENV.PINF_PROGRAM, "../.rt/program.rt.json");
	//   * The mode the runtime should run it. Will load `program.$PINF_MODE.json`.
	self.ENV.PINF_MODE = options.PINF_MODE || "production";

	if (typeof module === "string") {
		self.module = {
			dirname: module
		};
		module = self.module;
	} else {
		self.module = module;
	}

	module.pinf = DEEPMERGE(module.pinf || {}, {
		iid: "singleton",
		uid: null,
		ns: {
			filename: null,
			config: null,
			env: null
		},
		paths: {
			runtime: self.ENV.PINF_RUNTIME,
			program: self.ENV.PINF_PROGRAM,
			package: null,
			data: null,
			conf: null,
			log: null,
			pid: null
		},
		env: {},
		config: {},
		main: false
	});

	function findDescriptor(packagePath, basename) {
		var descriptorPath = PATH.join(packagePath, basename);
		while (!FS.existsSync(descriptorPath)) {
			var newPath = PATH.join(descriptorPath, "../..", PATH.basename(descriptorPath));
			if (newPath === descriptorPath) return false;
			descriptorPath = newPath;
			if (FS.existsSync(descriptorPath)) {
				break;
			}
		}
		return descriptorPath;
	}

	var packagePath = null;
	if (module.dirname) {
		packagePath = module.dirname;
	} else
	if (module.filename) {
		packagePath = PATH.dirname(module.filename);
	} else {
		throw new Error("Cannot determine package path.");
	}
	module.pinf.paths.package = packagePath;

	var packageDescriptorPath = findDescriptor(module.pinf.paths.package, "package.json");
	if (!packageDescriptorPath) {
		throw new Error("No `package.json` found for path '" + module.pinf.paths.package + "'");
	}

	function loadJSON(path, onFound) {
		if (!FS.existsSync(path)) return null;
		try {
			var json = FS.readFileSync(path).toString();
			// Replace environment variables.
            // NOTE: We always replace `$__DIRNAME` with the path to the directory holding the descriptor.
            json = json.replace(/\$__DIRNAME/g, PATH.dirname(path));
			// TODO: Replace by looping through `process.env` rather than the other way around.
			var m = json.match(/\$([A-Z0-9_]*)/g);
			if (m) {
				m.forEach(function(name) {
					ASSERT(typeof self.ENV[name.substring(1)] === "string", "The '" + name.substring(1) + "' environment variable must be set!")
					json = json.replace(new RegExp("\\" + name, "g"), self.ENV[name.substring(1)]);
				});
			}
			var obj = JSON.parse(json);
			if (obj && onFound) onFound(obj);
			return obj;
		} catch(err) {
			try {
				JSONLINT.parse(json);
			} catch(err) {
				err.message += " (while parsing '" + path + "')";
				throw err;
			}
			err.message += " (while parsing '" + path + "')";
			throw err;
		}
	}

	function insertNamespace(obj, property, ns) {
		if (typeof obj[property] !== "undefined") {
			var value = obj[property];
			obj[property] = {};
			obj[property][ns] = value;
		}
	}

	function formatUid(uri) {
		if (!uri) return false;
		var parsedUri = URL.parse(uri);
		if (parsedUri) {
			uri = ((parsedUri.hostname)?parsedUri.hostname:"") + parsedUri.pathname;
		}
		return uri;
	}

	// Precedence:
	var descriptor = {};
	var packageUid = false;
	//   6) ./package.json
	loadJSON(packageDescriptorPath, function(obj) {
		insertNamespace(obj, "config", ".");
		insertNamespace(obj, "env", ".");
		descriptor = DEEPMERGE(descriptor, obj);
		packageUid = formatUid(descriptor.uid);
	});
	//   5) /program.json
	loadJSON(self.ENV.PINF_PROGRAM, function(obj) {
		descriptor = DEEPMERGE(descriptor, obj);
	});
	//   4) ./.package.json
	loadJSON(packageDescriptorPath.replace(/\/([^\/]*)$/, "\/.$1"), function(obj) {
		insertNamespace(obj, "config", ".");
		insertNamespace(obj, "env", ".");
		descriptor = DEEPMERGE(descriptor, obj);
		packageUid = formatUid(descriptor.uid) || packageUid;
	});
	//   3) /.program.json
	loadJSON(self.ENV.PINF_PROGRAM.replace(/\/([^\/]*)$/, "\/.$1"), function(obj) {
		descriptor = DEEPMERGE(descriptor, obj);
	});
	//   2) /.rt/program.rt.json
	//		The `rt` descriptor holds the runtime information for this instance of the program. There can always
	//		only be one runtime instance of a program installation. If you want to boot a second, create an
	//		inheriting program descriptor in a new directory and boot it there.
	loadJSON(self.ENV.PINF_RUNTIME, function(obj) {
		descriptor = DEEPMERGE(descriptor, obj);
	});
	//   1) /program.$PINF_MODE.json
	loadJSON(self.ENV.PINF_PROGRAM.replace(".json", "." + self.ENV.PINF_MODE + ".json"), function(obj) {
		descriptor = DEEPMERGE(descriptor, obj);
	});

	module.pinf.uid = formatUid(module.pinf.uid || packageUid || PATH.dirname(packageDescriptorPath));
	module.pinf.ns.filename = module.pinf.ns.filename || exports.uriToFilename(module.pinf.uid + "+" + module.pinf.iid);
	module.pinf.ns.config = module.pinf.ns.config || packageUid || ".";
	module.pinf.ns.env = module.pinf.ns.env || module.pinf.ns.config;
	module.pinf.main = descriptor.main || false;

	Object.keys(module.pinf.paths).forEach(function(type) {
		if (module.pinf.paths[type]) return;
		if (descriptor.directories && descriptor.directories[type]) {
			module.pinf.paths[type] = PATH.resolve(packageDescriptorPath, descriptor.directories[type]);
		} else {
			module.pinf.paths[type] = PATH.join(self.ENV.PINF_RUNTIME, "..", type, module.pinf.ns.filename);
		}
	});

	function mergePropertyFor(name, ns) {
		if (
			descriptor &&
			descriptor[name] &&
			descriptor[name][ns]
		) {
			module.pinf[name] = DEEPMERGE(module.pinf[name] || {}, descriptor[name][ns]);
		}
	}

	// Precedence:
	//   3) Referenced by `.`.
	mergePropertyFor("config", ".");
	mergePropertyFor("env", ".");
	//   2) Referenced by `uid`.
	mergePropertyFor("config", module.pinf.uid);
	mergePropertyFor("env", module.pinf.uid);
	//   1) Referenced by `ns.*`.
	if (ns) {
		// If `ns` is array, load all namespaces.
		if (ns.indexOf("/") === -1) {
			var properties = [
				"mappings",
				"optionalMappings",
				"devMappings"
			];
			for (var i=0; i<properties.length ; i++) {
				if (descriptor[properties[i]][ns] && typeof descriptor[properties[i]][ns] === "string") {
					var parsedUri = URL.parse("http://" + descriptor[properties[i]][ns]);
					if (parsedUri.hostname && !/\/$/.test(parsedUri.pathname)) {
						ns = parsedUri.hostname + PATH.dirname(parsedUri.pathname) + "/";
						break;
					}
				}
			}
		}
		mergePropertyFor("config", ns);
		mergePropertyFor("config", ns + "0");
		mergePropertyFor("env", ns);
	} else {
		if (module.pinf.ns && module.pinf.ns.config) {
			mergePropertyFor("config", module.pinf.ns.config);
			// TODO: Add proper semver based matching of config rules with versions against package version.
			mergePropertyFor("config", module.pinf.ns.config + "0");
		}
		if (module.pinf.ns && module.pinf.ns.env) {
			mergePropertyFor("env", module.pinf.ns.env);
		}
	}

	self._credentials = descriptor.credentials || {};
}

PINF.prototype.config = function(extra) {
	var config = DEEPMERGE(this.module.pinf.config || {}, extra || {});
	config.pinf = this.module.pinf;
	return config;
}

PINF.prototype.credentials = function() {
	return this._credentials;
}

PINF.prototype.path = function(options, type, subpath, filename) {
	if (!options.pinf) {
		throw new Error("`options` does not contain a `pinf` property.");
	}
	if (!options.pinf.paths[type]) {
		throw new Error("Path for type '" + type + "' not found for package: " + options.pinf.paths.package);
	}
	var path = PATH.join(options.pinf.paths[type], subpath);
	if (!FS.existsSync(path)) {
		FS.mkdirsSync(path);
	}
	return PATH.join(path, filename);
}

// One instance for a given package per program (multiple via iid).
// NOTE: This function may take a while to return depending on the number of runtimes
//		 to sync across, their distance, and db used to sync.
PINF.prototype.singleton = function(config, constructor, callback) {
	var self = this;
	var id = [
	    config.pinf.uid,
	    config.pinf.iid
	].join(":");
	// TODO: Keep track of instance across processes. i.e. only one process per `uid : iid`
	function finalize(callback) {
		return callback(null, instances[self.ENV.PINF_RUNTIME][id]);
	}
	if (!instances[self.ENV.PINF_RUNTIME] || !instances[self.ENV.PINF_RUNTIME][id]) {
		try {
			var Instance = function() {
				this.config = config;
			}
			Instance.prototype = new constructor();
			Instance.prototype.anchorInstance = function(anchor, callback) {

//	console.log("SET PID OF PROCESS", anchor);
	// TODO: Attach instance pointer to persistant storage (local fs, central db, etc...)
				return callback(null);
			}
			if (!instances[self.ENV.PINF_RUNTIME]) instances[self.ENV.PINF_RUNTIME] = {};
			instances[self.ENV.PINF_RUNTIME][id] = new Instance();
			instances[self.ENV.PINF_RUNTIME][id].__construct(function(err) {
				if (err) return callback(err);

//console.log("got init");
				// TODO: Save config so it gets loaded for other clients and in future.

				return finalize(callback);
			});
		} catch(err) {
			return callback(err);
		}
	} else {
		return finalize(callback);
	}
}

PINF.prototype.resolve = function(id, callback) {
	return sm(this, function(err, SM) {
		if (err) return callback(err);
		return SM.resolve(id, callback);
	});
}
PINF.prototype.require = function(id, callback) {
	return sm(this, function(err, SM) {
		if (err) return callback(err);
		return SM.require(id, callback);
	});
}

PINF.prototype.run = function(program) {
	function error(err) {
		if (err && typeof err === "object") {
			console.error(err.stack);
		}
		process.exit(1);
	}
	try {
		program(function(err) {
			if (err) return error(err);
			process.exit(0);
		});
	} catch(err) {
		return error(err);
	}
}


function sm(instance, callback) {
	ASSERT(typeof process.env.SM_BIN_PATH === "string", "The 'SM_BIN_PATH' environment variable must be set!")
	try {
		return callback(null, require(PATH.join(FS.realpathSync(process.env.SM_BIN_PATH), "../../lib/sm.js")).for(instance.module.pinf.paths.package, {
			verbose: !!process.env.SM_VERBOSE,
			debug: !!process.env.SM_DEBUG,
			now: process.env.SM_NOW ? process.env.SM_NOW : false
		}));
	} catch(err) {
		return callback(err);
	}
}
