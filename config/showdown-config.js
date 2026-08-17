'use strict';

exports.port = Number(process.env.POKEMONAI_SHOWDOWN_PORT || 8000);
exports.bindaddress = process.env.POKEMONAI_SHOWDOWN_BIND || '127.0.0.1';
exports.ssl = null;
exports.wsdeflate = null;
exports.proxyip = false;
exports.crashguard = true;
exports.logchallenges = true;
exports.autosavereplays = false;
exports.logsdir = process.env.POKEMONAI_SHOWDOWN_LOGS || 'logs';
exports.loginserver = 'https://play.pokemonshowdown.com/';
exports.subprocesses = {
	network: 1,
	simulator: 1,
	validator: 1,
	verifier: 1,
	localartemis: 0,
	remoteartemis: 0,
	friends: 0,
	chatdb: 0,
	modlog: 0,
	pm: 0,
	battlesearch: 0,
	datasearch: 0,
};
