import mongoose from 'mongoose'

const roomSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true },
    code: { type: String, default: '' },
    passwordHash: { type: String, default: null },
  },
  { timestamps: true }
)

export default mongoose.model('Room', roomSchema)
