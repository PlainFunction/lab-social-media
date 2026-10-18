import { createSlackAgent } from '#capabilities'
import { tools } from './tools'

// The whole agent is core's slack-agent module. This Worker only says which tools it has.
export default createSlackAgent({ tools })
