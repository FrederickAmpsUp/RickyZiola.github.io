const EventEmitter = require("events");
var Promise = require("promise");
var WebSocket = require("ws");
var consts = require("./consts.js");

class WSHandler extends EventEmitter {
	constructor(session, token, kahoot) {
		super();
		var me = this;
		this.kahoot = kahoot;
		this.msgID = 0;
		this.clientID = "_none_";
		this.connected = false;
		this.gameID = session;
		this.name = "";
		this.firstQuizEvent = false;
		this.lastReceivedQ = null;
		this.ws = new WebSocket(consts.WSS_ENDPOINT + session + "/" + token, {
			origin: "https://kahoot.it/"
		});
		// Create anonymous callbacks to prevent an event emitter loop
		this.ws.on("open", () => {
			me.open();
		});
		this.ws.on("message", msg => {
			me.message(msg);
		});
		this.ws.on("close", () => {
			me.connected = false;
			me.close();
		});
		this.dataHandler = {
			1: (data, content) => {
				if (!me.kahoot.quiz.currentQuestion) {
					me.emit("quizUpdate", {
						questionIndex: content.questionIndex,
						timeLeft: content.timeLeft,
						type: content.gameBlockType,
						useStoryBlocks: content.canAccessStoryBlocks,
						ansMap: content.answerMap
					});
				} else if (content.questionIndex > me.kahoot.quiz.currentQuestion.index) {
					me.emit("quizUpdate", {
						questionIndex: content.questionIndex,
						timeLeft: content.timeLeft,
						type: content.gameBlockType,
						useStoryBlocks: content.canAccessStoryBlocks,
						ansMap: content.answerMap
					});
				}
			},
			2: (data, content) => {
				me.emit("questionStart");
			},
			3: (data, content) => {
				me.emit("finish", {
					playerCount: content.playerCount,
					quizID: content.quizID,
					rank: content.rank,
					correct: content.correctCount,
					incorrect: content.incorrectCount
				});
			},
			7: (data, content) => {
				me.emit("questionSubmit", content.primaryMessage);
			},
			8: (data, content) => {
				// console.log(data);
				me.emit("questionEnd", {
					correctAnswers: content.correctAnswers,
					correct: content.isCorrect,
					points: content.points,
					pointsData: content.pointsData,
					rank: content.rank,
					nemesis: content.nemesis,
					hasNemesis: content.nemisisIsGhost,
					text: content.text
				});
			},
			9: (data, content) => {
				if (!me.firstQuizEvent) {
					me.firstQuizEvent = true;
					me.emit("quizData", {
						name: content.quizName,
						type: content.quizType,
						qCount: content.quizQuestionAnswers[0]
					});
				}
			},
			10: (data, content) => {
				// The quiz has ended
				me.emit("quizEnd");
				try {
					me.ws.close();
				} catch (e) {
					// Most likely already closed
				}
			},
			13: (data, content) => {
				me.emit("finishText", {
					metal: content.podiumMedalType,
					msg1: content.primaryMessage,
					msg2: content.secondaryMessage
				});
			}
		}
	}
	getExt() {
		return {
			ack: true,
			timesync: {
				l: 0,
				o: 0,
				tc: (new Date).getTime()
			}
		}
	}
	getPacket(packet) {
		var l = ((new Date).getTime() - packet.ext.timesync.tc - packet.ext.timesync.p) / 2;
		var o = (packet.ext.timesync.ts - packet.ext.timesync.tc - l);
		var ack;
		var me = this;
		me.msgID++;
		return [{
			channel: packet.channel,
			clientId: me.clientID,
			ext: {
				ack: packet.ext.ack,
				timesync: {
					l: l,
					o: o,
					tc: (new Date).getTime()
				}
			},
			id: me.msgID + ""
		}]
	}
	getSubmitPacket(questionChoice) {
		var me = this;
		me.msgID++;
		return [{
			channel: "/service/controller",
			clientId: me.clientID,
			data: {
				content: JSON.stringify({
					choice: questionChoice,
					meta: {
						lag: 30,
						device: {
							userAgent: "kahoot.js",
							screen: {
								width: 1920,
								height: 1050
							}
						}
					}
				}),
				gameid: me.gameID,
				host: consts.ENDPOINT_URI,
				id: 6,
				type: "message"
			},
			id: me.msgID + ""
		}]
	}
	send(msg) {
		if (this.connected) {
			try {
				this.ws.send(JSON.stringify(msg));
			} catch(e) { }
		}
	}
	sendSubmit(questionChoice) {
		var packet = this.getSubmitPacket(questionChoice);
		this.send(packet);
	}
	open() {
		var me = this;
		this.connected = true;
		this.emit("open");
		var r = [{
			advice: {
				interval: 0,
				timeout: 60000
			},
			channel: consts.CHANNEL_HANDSHAKE,
			ext: {
				ack: true,
				timesync: {
					l: 0,
					o: 0,
					tc: (new Date).getTime()
				},
				id: "1",
				minimumVersion: "1.0",
				supportedConnectionTypes: [
					"websocket",
					"long-polling"
				],
				version: "1.0"
			}
		}];
		me.msgID++;
		me.send(r);
	}
	message(msg) {
		var me = this;
		var data = JSON.parse(msg)[0];
		if (data.channel == consts.CHANNEL_HANDSHAKE && data.clientId) { // The server sent a handshake packet
			this.clientID = data.clientId;
			var r = me.getPacket(data)[0];
			r.ext.ack = undefined;
			r.channel = consts.CHANNEL_SUBSCR;
			r.clientId = me.clientID;
			r.subscription = "/service/controller";
			me.send(r);
		} else if (data.channel == consts.CHANNEL_SUBSCR) {
			if (data.subscription == "/service/controller" && data.successful == true) {
				var playerSubscribe = me.getPacket(data)[0];
				playerSubscribe.channel = consts.CHANNEL_SUBSCR;
				playerSubscribe.clientId = me.clientID;
				playerSubscribe.subscription = "/service/player";
				me.send(playerSubscribe);
				var connectionPacket = me.getPacket(data)[0];
				connectionPacket.channel = consts.CHANNEL_CONN;
				connectionPacket.clientId = me.clientID;
				connectionPacket.connectionType = "websocket";
				connectionPacket.advice = {
					timeout: 0
				}
				me.send(connectionPacket);
				var statusSubscribe = me.getPacket(data)[0];
				statusSubscribe.channel = consts.CHANNEL_SUBSCR;
				statusSubscribe.clientId = me.clientID;
				statusSubscribe.subscription = "/service/status";
				me.send(statusSubscribe);
				me.emit("ready");
			}
		} else if (data.data) {
			if (data.data.error) {
				me.emit("error", data.data.error);
				return;
			} else if (data.data.type == "loginResponse") {
				// "/service/controller"
				me.emit("joined");
			} else {
				if (data.data.content) {
					var cont = JSON.parse(data.data.content);
					if (me.dataHandler[data.data.id]) {
						me.dataHandler[data.data.id](data, cont);
					} else {
						// console.log(data);
					}
				}
			}
		}
		if (data.ext && data.channel !== "/meta/subscribe" && data.channel !== "/meta/handshake") {
			var m = me.getPacket(data);
			me.send(m);
		}
	}
	login(name) {
		var me = this;
		me.name = name;
		var joinPacket = [{
			channel: "/service/controller",
			clientId: me.clientID,
			data: {
				gameid: me.gameID,
				host: consts.ENDPOINT_URI,
				name: name,
				type: "login"
			},
			id: me.msgID + ""
		}];
		me.msgID++;
		this.send(joinPacket);
	}
	close() {
		this.connected = false;
		this.emit("close");
	}
}
module.exports = WSHandler;
