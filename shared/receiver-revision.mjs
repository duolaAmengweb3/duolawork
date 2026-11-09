// A missing process receipt is unknown, not evidence of an outdated install.
export function receiverVersion(actual,targetRevision){
 const receiverRevision=/^[a-f0-9]{64}$/.test(actual||'')?actual:null;
 return{receiverRevision,targetRevision,revisionKnown:!!receiverRevision,revisionState:receiverRevision?(receiverRevision===targetRevision?'current':'outdated'):'unknown',updateAvailable:!!receiverRevision&&receiverRevision!==targetRevision};
}
