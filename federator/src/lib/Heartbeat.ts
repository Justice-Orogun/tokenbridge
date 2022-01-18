import Web3 from 'web3';
import { Config } from './config';
import { ConfigChain } from './configChain';

import fs from 'fs';
import TransactionSender from './TransactionSender';
import { CustomError } from './CustomError';
import { FederationFactory } from '../contracts/FederationFactory';
import * as utils from '../lib/utils';
import { IFederation } from '../contracts/IFederation';
import { LogWrapper } from './logWrapper';
const fedVersion = process.env.npm_package_version;

export class Heartbeat {
  config: Config;
  logger: LogWrapper;
  mainWeb3: Web3;
  sidesWeb3: Web3[];
  transactionSender: any;
  lastBlockPath: string;
  federationFactory: FederationFactory;
  metricCollector: any;

  constructor(config: Config, logger: LogWrapper, metricCollector) {
    this.config = config;
    this.logger = logger;

    this.mainWeb3 = new Web3(config.mainchain.host);

    this.metricCollector = metricCollector;
    this.federationFactory = new FederationFactory(this.config, this.logger, config.mainchain);
    this.transactionSender = new TransactionSender(this.mainWeb3, this.logger, this.config);
    this.lastBlockPath = `${config.storagePath || __dirname}/heartBeatLastBlock.txt`;
    this.sidesWeb3 = [];
    for (const sideChainConfig of config.sidechain) {
      this.sidesWeb3.push(new Web3(sideChainConfig.host));
    }
  }

  async run(): Promise<boolean> {
    await this._checkIfRsk();
    let retries = 3;
    const sleepAfterRetryMs = 3000;
    while (retries > 0) {
      try {
        const promiseChainsId = [];
        const promiseBlocks = [];
        const promiseNodesInfo = [];

        promiseChainsId.push(this.mainWeb3.eth.net.getId());
        promiseBlocks.push(this.mainWeb3.eth.getBlockNumber());
        promiseNodesInfo.push(this.mainWeb3.eth.getNodeInfo());

        for (const sideWeb3 of this.sidesWeb3) {
          promiseChainsId.push(sideWeb3.eth.net.getId());
          promiseBlocks.push(sideWeb3.eth.getBlockNumber());
          promiseNodesInfo.push(sideWeb3.eth.getNodeInfo());
        }

        const [fedChainsId, fedChainsBlocks, fedChainInfo] = await Promise.all([
          Promise.all(promiseChainsId),
          Promise.all(promiseBlocks),
          Promise.all(promiseNodesInfo),
        ]);

        return await this._emitHeartbeat(fedVersion, fedChainsId, fedChainsBlocks, fedChainInfo);
      } catch (err) {
        this.logger.error(new Error('Exception Running Heartbeat'), err);
        retries--;
        this.logger.debug(`Run ${3 - retries} retry`);
        if (retries > 0) {
          await utils.sleep(sleepAfterRetryMs);
        } else {
          process.exit(1);
        }
      }
    }
    return false;
  }

  checkStoragePath() {
    if (!fs.existsSync(this.config.storagePath)) {
      fs.mkdirSync(this.config.storagePath, {
        recursive: true,
      });
    }
  }

  getFromBlock(): number {
    const originalFromBlock = this.config.mainchain.fromBlock;
    let fromBlock = null;
    try {
      fromBlock = fs.readFileSync(this.lastBlockPath, 'utf8');
    } catch (err) {
      fromBlock = originalFromBlock;
    }

    if (fromBlock < originalFromBlock) {
      return originalFromBlock;
    }
    return parseInt(fromBlock);
  }

  async handleReadLogsPage(
    numberOfPages: number,
    fromPageBlock: number,
    recordsPerPage: number,
    toBlock: number,
    fedContract: IFederation,
  ) {
    for (let currentPage = 1; currentPage <= numberOfPages; currentPage++) {
      let toPagedBlock = fromPageBlock + recordsPerPage - 1;
      if (currentPage === numberOfPages) {
        toPagedBlock = toBlock;
      }

      this.logger.debug(`Page ${currentPage} getting events from block ${fromPageBlock} to ${toPagedBlock}`);
      const heartbeatLogs = await fedContract.getPastEvents('HeartBeat', {
        fromBlock: fromPageBlock,
        toBlock: toPagedBlock,
      });

      if (!heartbeatLogs) {
        throw new Error('Failed to obtain HeartBeat logs');
      }
      await this._processHeartbeatLogs(heartbeatLogs, {
        sidesChainIds: await Promise.all(this.sidesWeb3.map((sideWeb3) => sideWeb3.eth.net.getId)),
        sidesLastBlock: await Promise.all(this.sidesWeb3.map((sideWeb3) => sideWeb3.eth.getBlockNumber())),
      });

      this.logger.info(`Found ${heartbeatLogs.length} heartbeatLogs`);

      this._saveProgress(this.lastBlockPath, toPagedBlock);
      fromPageBlock = toPagedBlock + 1;
    }
  }

  async readLogs() {
    await this._checkIfRsk();
    let retries = 3;
    const sleepAfterRetrie = 3000;
    while (retries > 0) {
      try {
        const currentBlock = await this.mainWeb3.eth.getBlockNumber();
        const fedContract = await this.federationFactory.getMainFederationContract();

        const toBlock = currentBlock;
        this.logger.info('Running to Block', toBlock);

        if (toBlock <= 0) {
          return false;
        }

        this.checkStoragePath();
        let fromBlock = this.getFromBlock();

        if (fromBlock >= toBlock) {
          this.logger.warn(
            `Current chain Height ${toBlock} is the same or lesser than the last block processed ${fromBlock}`,
          );
          return false;
        }
        fromBlock = fromBlock + 1;
        this.logger.debug('Running from Block', fromBlock);

        const recordsPerPage = 1000;
        const numberOfPages = Math.ceil((toBlock - fromBlock) / recordsPerPage);
        this.logger.debug(`Total pages ${numberOfPages}, blocks per page ${recordsPerPage}`);

        await this.handleReadLogsPage(numberOfPages, fromBlock, recordsPerPage, toBlock, fedContract);
        return true;
      } catch (err) {
        this.logger.error(new Error('Exception Running Federator'), err);
        retries--;
        this.logger.debug(`Run ${3 - retries} retrie`);
        if (retries <= 0) {
          process.exit(1);
        }
        await utils.sleep(sleepAfterRetrie);
      }
    }
    return false;
  }

  async _processHeartbeatLogs(logs, { sidesChainIds, sidesLastBlock }) {
    /*
        if node it's not synchronizing, do ->
    */

    try {
      for (const log of logs) {
        const { sender, currentChainId, currentBlock, fedVersion, fedChainsIds, fedChainsBlocks, fedChainsInfo } = log.returnValues;

        let logInfo = `[event: HeartBeat],`;
        logInfo += `[sender: ${sender}],`;
        logInfo += `[fedVersion: ${fedVersion}],`;
        logInfo += `[chainId: ${currentChainId}],`;
        logInfo += `[blockNumber: ${currentBlock}],`;
        logInfo += `[fedChainsIds: ${fedChainsIds}],`;
        logInfo += `[fedChainsBlocks: ${fedChainsBlocks}],`;
        logInfo += `[fedChainsInfo: ${fedChainsInfo}],`;
        // logInfo += `[fedEthBlock: ${fedEthBlock}],`;
        // logInfo += `[federatorVersion: ${federatorVersion}],`;
        // logInfo += `[nodeRskInfo: ${nodeRskInfo}],`;
        // logInfo += `[nodeEthInfo: ${nodeEthInfo}],`;
        // logInfo += `[RskBlockGap: ${blockNumber - fedRskBlock}],`;
        // logInfo += `[EstEthBlockGap: ${ethLastBlock - fedEthBlock}]`;

        this.logger.info(logInfo);
      }

      return true;
    } catch (err) {
      throw new CustomError(`Exception processing HeartBeat logs`, err);
    }
  }

  async _emitHeartbeat(fedVersion: string, fedChainIds: any[], fedChainsBlocks: any[], fedChainInfo: any[]) {
    try {
      const fedContract = await this.federationFactory.getMainFederationContract();
      const from = await this.transactionSender.getAddress(this.config.privateKey);
      const isMember = await fedContract.isMember(from);
      if (!isMember) {
        throw new Error(`This Federator addr:${from} is not part of the federation`);
      }

      this.logger.info(`emitHeartbeat(${fedVersion}, ${fedChainIds}, ${fedChainsBlocks}, ${fedChainInfo})`);
      await fedContract.emitHeartbeat(this.transactionSender, fedVersion, fedChainIds, fedChainsBlocks, fedChainInfo);
      this._trackHeartbeatMetrics(from, fedVersion, fedChainIds, fedChainsBlocks, fedChainInfo);
      this.logger.info(`Success emitting heartbeat`);
      return true;
    } catch (err) {
      throw new CustomError(
        `Exception Emitting Heartbeat fedVersion: ${fedVersion} fedChainIds: ${fedChainIds} fedChainsBlocks: ${fedChainsBlocks} fedChainsBlocks: ${fedChainInfo}`,
        err,
      );
    }
  }

  _trackHeartbeatMetrics(from, fedVersion, fedChainIds, fedChainsBlocks, fedChainInfo) {
    for (let i = 0; i < fedChainIds.length; i++) {
      //this.metricCollector?.trackSideChainHeartbeatEmission
      this.metricCollector?.trackMainChainHeartbeatEmission(
        from,
        fedVersion,
        fedChainsBlocks[i],
        fedChainInfo[i],
        fedChainIds[i],
      );
    }
  }

  _saveProgress(path, value) {
    if (value) {
      fs.writeFileSync(path, value.toString());
    }
  }

  async _checkIfRsk() {
    const chainId = await this.mainWeb3.eth.net.getId();
    if (!utils.checkIfItsInRSK(chainId)) {
      this.logger.error(new Error(`Heartbeat should only run on RSK ${chainId}`));
      process.exit(1);
    }
  }
}

export default Heartbeat;
