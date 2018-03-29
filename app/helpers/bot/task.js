'use strict'

const Promise = require('bluebird')
const steem = Promise.promisifyAll(require('steem'))
const sc2 = Promise.promisifyAll(require('sc2-sdk'))
const { user, wif, sc2_secret } = require('../../config')
const moment = require('moment')
const schedule = require('node-schedule')
const Sequelize = require('sequelize')
const models = require('../../../models')
const Op = Sequelize.Op;
const Handlebars = require('handlebars')
const fs = Promise.promisifyAll(require('fs'))
const path = require('path')
const rp = require('request-promise');


const UNVOTE_WEIGHT = 0

module.exports = {
    execute
}

let VOTING = {};
let COMMENTS = {};

const SECONDS_PER_HOUR = 3600
const PERCENT_PER_DAY = 20
const HOURS_PER_DAY = 24
const MAX_VOTING_POWER = 10000
const DAYS_TO_100_PERCENT = 100 / PERCENT_PER_DAY
const SECONDS_FOR_100_PERCENT = DAYS_TO_100_PERCENT * HOURS_PER_DAY * SECONDS_PER_HOUR
const RECOVERY_RATE = MAX_VOTING_POWER / SECONDS_FOR_100_PERCENT
const DEFAULT_THRESHOLD = 9500

const api = sc2.Initialize({
    app: 'we-resist',
    callbackURL: 'https://we-resist-bot.herokuapp.com/',
    accessToken: '',
    scope: ['vote', 'comment', 'offline']
  })


function current_voting_power(vp_last, last_vote) {
    var seconds_since_vote = moment().add(7, 'hours').diff(moment(last_vote), 'seconds')
    return (RECOVERY_RATE * seconds_since_vote) + vp_last
}

function time_needed_to_recover(voting_power, threshold) {
    return (threshold - voting_power) / RECOVERY_RATE
}

// Stubbed function
function list_of_grumpy_users() {
    let grumps = []
    grumps.push('grumpycat')
    return new Promise((resolve, reject) => {
        resolve(grumps)
    })
}

class Vote {
    constructor(vote_json) {
        this.voter = vote_json.voter
        this.author = vote_json.author
        this.permlink = vote_json.permlink
        this.weight = vote_json.weight
    }

    is_downvote() {
        return !this.is_upvote()
    }

    is_upvote() {
        return this.weight > 0
    }

    is_voter_grumpy() {
        // console.log("Comparing voter %s to %s", vote.voter, "grumpycat")
        return this.voter == 'grumpycat'
    }

    is_author_grumpy() {
        return list_of_grumpy_users()
            .filter((user) => this.author == user)
            .then((users) => { return users.length > 0 })
    }

    is_for_resister() {
        return list_of_resisters()
            .filter((resister) => this.author == resister.username)
            .then((resisters) => { return resisters.length > 0 })
    }
}

function processVote(vote) {
    if (!vote.is_voter_grumpy()) {
         return false
    }

    console.log("processing vote ", vote);

    if (vote.is_upvote()) {
        return processUpvote(vote)
    }

    vote.is_for_resister()
        .then((it_is) => {
            if (it_is) {
                return processDownvote(vote)
            }
            return invite(vote.author, vote.permlink);
        })
}

/**
 * Resisters look like
 * {
 *  name: firedream,
 *  upvoteWeight: 10000,
 *  downvoteWeight: -10000,
 *  active: true,
 *  wif: wif
 * }
 */
function list_of_resisters() {
    return models.Preferences.findAll( {
        attributes: [ 'username', 'wif', 'upvoteWeight', 'downvoteWeight', 'threshold' ],
        logging: (query) => {}
    })
}

function processDownvote(vote) {
    console.log('Processing vote ', vote)
    return collectiveUpvote(vote.author, vote.permlink)
}

function processUpvote(vote) {
    return vote.is_author_grumpy()
        .then((is_grumpy) => {
            if (is_grumpy) { // Test for self-vote
                console.log("Downvoting ", vote)
                return collectiveDownvote(vote.author, vote.permlink)
            }

            // Not a self-vote
            Promise.reject("Not a self vote")
        })
        .catch((err) => {
            console.log(err)
        })
}

function processUnvote(vote) {
    if (!vote.is_voter_grumpy()) {
        return false
    }

    return collectiveUnvote(author, permlink)
}

function invite(author, permlink) {
    return is_already_replied_to(author, permlink)
        .then((found) => {
            if (!found) {
                return reply(author, permlink, "invite")
            }
            return found;
        });
}

function is_already_replied_to(author, permlink) {
    return steem.api.getContentRepliesAsync(author, permlink)
        .filter((reply) => user == reply.author)
        .then((replies) => { return replies.length > 0 || COMMENTS.includes(author, permlink)})
}


function reply(author, permlink, type) {
    COMMENTS.push({ author: author, permlink: permlink, type: type })
}

function downvote(author, permlink, resister) {
    return new Promise((resolve, reject) => {
        try {
            vote(author, permlink, resister, resister.downvoteWeight * -100)
            resolve(true)
        }
        catch (err) {
            reject(err)
        }
    });
}

function upvote(author, permlink, resister) {
    return new Promise((resolve, reject) => {
        try {
            vote(author, permlink, resister, resister.upvoteWeight * 100)
            resolve(true)
        }
        catch (err) {
            reject(err)
        }
    });
}

function unvote(author, permlink, resister) {
    vote(author, permlink, resister, UNVOTE_WEIGHT)
}

function vote(author, permlink, resister, weight) {
    VOTING.push({ author: author, permlink: permlink, resister: resister, weight: weight })
}

function collectiveDownvote(author, permlink) {
    return list_of_resisters().each((resister) => { return downvote(author, permlink, resister) })
        .then(() => {
            return is_already_replied_to(author, permlink)
                .then((found) => { 
                    if (!found) {
                        return reply(author, permlink, "downvote") 
                    }   
                    return found;
                });    
            })

}

function collectiveUpvote(author, permlink) {
    return list_of_resisters().each((resister) => { return upvote(author, permlink, resister) })
        .then(() => {
            return is_already_replied_to(author, permlink)
                .then((found) => {
                    if (!found) { // we we haven't replied yet
                        return reply(author, permlink, "upvote") 
                    }
                    return found;
                });            
            })
}

function collectiveUnvote(author, permlink) {
    return list_of_resisters().each((resister) => { return unvote(author, permlink, resister) })
}

function processComment(comment) {
    return list_of_resisters()
        .filter((resister) => comment.author == resister.username)
        .each((resister) => {
            var recovery_wait = 0
            return steem.api.getAccountsAsync([ user ]).then((accounts) => {
                if (accounts && accounts.length > 0) {
                    const account = accounts[0];
                    console.log("Getting voting power for %d %s", account.voting_power, account.last_vote_time)
                    var voting_power = current_voting_power(account.voting_power, account.last_vote_time)
                    recovery_wait = time_needed_to_recover(voting_power, DEFAULT_THRESHOLD) / 60
                    return account
                }
            })
            .then((account) => {
                // Reschedule vote
                if (recovery_wait > 0) {
                    var later = moment().add(recovery_wait, 'minutes').toDate()
                    console.log("Rescheduling ", recovery_wait, " minutes to recover")
                    schedule.scheduleJob(later, function() {
                        processComment(comment)
                    })
                    return account
                }
                return vote(comment.author, comment.permlink, { username: user, wif: wif }, 10000)
            })
        })
}

function mainLoop() {
    processVote(new Vote({ permlink: "re-snowpea-re-drakos-re-snowpea-happy-haturday-and-other-random-stuff-20180326t041618288z", author: "grumpycat", voter: "madpuppy", weight: 10000 }))
    processVote(new Vote({ permlink: "re-good-karme-amazing-view-of-white-flower--today-i-ca-2018-03-18-15-49-15-20180326t034705670z", author: "grumpycat", voter: "grumpycat", weight: 10000 }))
    processVote(new Vote({ permlink: "re-good-karme-amazing-view-of-white-flower--today-i-ca-2018-03-18-15-49-15-20180326t034705670z", author: "grumpycat", voter: "grumpycat", weight: 10000 }))
    processVote(new Vote({ permlink: "re-rickyyolanda86-the-front-road-of-north-aceh-bupati-s-hall-ab148a17ba618-20180326t034830986z", author: "grumpycat", voter: "grumpycat", weight: 10000 }))
    processVote(new Vote({ permlink: "re-jie28-62dvel-long-exposure-photography-20180326t035341580z", author: "grumpycat", voter: "grumpycat", weight: 10000 }))
    processVote(new Vote({ permlink: "re-hajevoy60-longexposurephotography-fountain-of-amphitrite-in-the-market-square-in-lviv-20180326t035518662z", author: "grumpycat", voter: "grumpycat", weight: 10000 }))
    processVote(new Vote({ permlink: "re-nicholasmwanje-my-golden-hour-contest-20180326t035553668z", author: "grumpycat", voter: "grumpycat", weight: 10000 }))
    processVote(new Vote({ permlink: "re-travoved-moonlight-night-in-golden-horn-bay-20180326t035736656z", author: "grumpycat", voter: "grumpycat", weight: 10000 }))
    processVote(new Vote({ permlink: "re-nicholasmwanje-herbal-medicine-photography-20180326t035920444z", author: "grumpycat", voter: "grumpycat", weight: 10000 }))
    processVote(new Vote({ permlink: "re-abontikazaman-4lmaym-here-is-my-entry-longexposurephotography-which-is-powered-by-juliank-20180326t040245512z", author: "grumpycat", voter: "grumpycat", weight: 10000 }))
    processVote(new Vote({ permlink: "re-chbartist-construyendo-el-camino-al-exito-capitulo-1-20180327t191349910z", author: "grumpycat", voter: "grumpycat", weight: 10000 }))
    processVote(new Vote({ permlink: "re-steemitmwanje1-color-challenge-20180326t040047610z", author: "grumpycat", voter: "grumpycat", weight: 10000 }))
    processVote(new Vote({ permlink: "re-boyasyie-seminar-to-invest-in-steemit-com-f3a807d4f934c-20180326t040006708z", author: "grumpycat", voter: "grumpycat", weight: 10000 }))
    processVote(new Vote({ permlink: "re-olgamaslievich-endless-walls-around-the-castle-longexposurephotography-by-olga-maslievich-20180326t035843150z", author: "grumpycat", voter: "grumpycat", weight: 10000 }))
    processVote(new Vote({ permlink: "re-aniellopas-green-waterfall-20180326t035437654z", author: "grumpycat", voter: "grumpycat", weight: 10000 }))
    processVote(new Vote({ permlink: "re-dailytop10open-2bgqay-daily-top-10-crypto-rises-20180327t184115638z", author: "grumpycat", voter: "grumpycat", weight: 10000 }))
    processVote(new Vote({ permlink: "5tmwcf-daily-top-crypto-open-price", author: "dailytop10open", voter: "grumpycat", weight: -10000 }))
    processVote(new Vote({ permlink: "2", author: "dailytop10open", voter: "grumpycat", weight: -10000 }))
    processVote(new Vote({ permlink: "59sjn2-daily-top-10-crypto-rises", author: "dailytop10open", voter: "grumpycat", weight: -10000 }))
    processVote(new Vote({ permlink: "3pksn2-daily-top-10-crypto-rises", author: "dailytop10open", voter: "grumpycat", weight: -10000 }))
    processVote(new Vote({ permlink: "55uqtk-daily-top-crypto-open-price", author: "dailytop10open", voter: "grumpycat", weight: -10000 }))
    processVote(new Vote({ permlink: "765blm-daily-top-crypto-open-price", author: "dailytop10open", voter: "grumpycat", weight: -10000 }))
    processVote(new Vote({ permlink: "2bgqay-daily-top-10-crypto-rises", author: "dailytop10open", voter: "grumpycat", weight: -10000 }))
    processVote(new Vote({ permlink: "8", author: "dailytop10open", voter: "grumpycat", weight: -10000 }))
    processVote(new Vote({ permlink: "6", author: "dailytop10open", voter: "grumpycat", weight: -10000 }))
    processVote(new Vote({ permlink: "4", author: "dailytop10open", voter: "grumpycat", weight: -10000 }))
    processVote(new Vote({ permlink: "re-grumpycat-re-chbartist-construyendo-el-camino-al-exito-capitulo-1-20180328t151019728z", author: "kupisikhan", voter: "grumpycat", weight: -10000 }))
    processVote(new Vote({ permlink: "best-author-reward-project-for-steemians", author: "upmewhale", voter: "grumpycat", weight: -10000 }))

    console.log("Processing votes from stream of operations")
    steem.api.streamOperations('head', (err, result) => {
        if (result && result.length > 0) {
            var operation_name = result[0]
            switch(operation_name) {
                case 'comment':
                    if (operation.parent_author == '') {
                        processComment(operation)
                            .catch((e) => {
                                console.log("Failed to process comment ", e)
                            });
                    }
                    break;
                case 'vote':
                    processVote(new Vote(result[1]))
                    break;
                case 'unvote':
                    processUnvote(new Vote(result[1]))
                    break;
                default:
            }   
        }
    })
}

function execute(voting_queue, comment_queue) {
    VOTING = voting_queue;
    COMMENTS = comment_queue;
    mainLoop();
}