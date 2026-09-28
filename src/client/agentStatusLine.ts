const lines = [
  "This too shall compile.",
  "I think, therefore I lint.",
  "Somewhere, a rubber duck is nodding.",
  "The plot thickens. The functions get smaller.",
  "Life is short. So are good functions.",
  "Patience is a virtue. Caching is a strategy.",
  "A journey of a thousand lines begins with one typo.",
  "There are no shortcuts, only keyboard shortcuts.",
  "The code abides.",
  "Stay curious. The compiler certainly is.",
  "To err is human. To retry is a design decision.",
  "Turning coffee into plausible explanations.",
  "Seeking inner peace and fewer dependencies.",
  "All roads lead to one more edge case.",
  "A little less chaos, one semicolon at a time.",
  "The answer is out there. Probably in the logs.",
  "Good things come to those who await.",
  "Putting the fun in function.",
  "The grass is greener where the tests pass.",
  "Keeping an open mind and a closed bracket.",
  "Every cloud has a local development environment.",
  "In search of the meaning of null.",
  "Measure twice. Refactor once, then once more.",
  "Dream big. Commit small.",
  "A watched build never boils.",
  "Where there’s a will, there’s a workaround.",
  "Nothing is certain except change and cache invalidation.",
  "Less yak shaving, more sweater knitting.",
  "One small step for code, one giant leap for readability.",
  "The unexamined loop is not worth repeating.",
  "Making room for a little method in the madness.",
  "May your branches be short and your merges peaceful.",
];

export function agentStatusLine(agentId: string, runId = "") {
  // UUIDs give each agent/run a varied choice without changing on every poll.
  let hash = 2166136261;
  for (const char of `${agentId}:${runId}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  }
  return lines[(hash >>> 0) % lines.length];
}
