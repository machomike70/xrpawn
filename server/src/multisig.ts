import { AccountSetAsfFlags, type Client, type Wallet } from 'xrpl'
import { submitWithWallet } from './xrpl.js'

/**
 * Turn a single-key account into an M-of-N multisig account and disable its master key.
 * After this, only `quorum` of the listed signer keys together can authorize anything from the account.
 */
export async function convertToMultisig(client: Client, master: Wallet, signerAddresses: string[], quorum: number) {
  if (quorum < 2 || quorum > signerAddresses.length) throw new Error('quorum must be between 2 and the number of signers')
  // submitWithWallet throws unless the transaction validated with tesSUCCESS
  await submitWithWallet(
    client,
    {
      TransactionType: 'SignerListSet',
      Account: master.classicAddress,
      SignerQuorum: quorum,
      SignerEntries: signerAddresses.map((a) => ({ SignerEntry: { Account: a, SignerWeight: 1 } })),
    },
    master,
  )
  await submitWithWallet(
    client,
    { TransactionType: 'AccountSet', Account: master.classicAddress, SetFlag: AccountSetAsfFlags.asfDisableMaster },
    master,
  )
}
