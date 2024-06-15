import {
    currentBlockTime,
    executeTestScenarios,
    getZkTestProvider,
    setUpTest
} from "./utils";
import hre from "hardhat";
import {time} from "@nomicfoundation/hardhat-network-helpers";
import {OrderCloseReason, OrderSide} from "../index";

describe("OrderBook - Blackbox testing expiry", async () => {
    it("Submit expired order should fail", async () => {
        const load = await setUpTest();
        await executeTestScenarios(load, [{
            updateAllowance: {from: load.bob, token: load.USDC, amount: 'max'}
        }, {
            submitOrder: {
                owner: load.bob, side: OrderSide.BUY, amount: 1, price: 1,
                validUtil: await currentBlockTime() - 1,
                expectReverted: {
                    message: "Invalid validUntil"
                }
            }
        }]);
    });

    it("Expired order shouldn't be filled", async () => {
        const load = await setUpTest();
        await executeTestScenarios(load, [{
            updateAllowance: [
                {from: load.bob, token: load.USDC, amount: 'max'},
                {from: load.alice, token: load.WETH, amount: 'max'}
            ]
        }, {
            submitOrder: {
                alias: 'order1', owner: load.bob, side: OrderSide.BUY,
                amount: load.fmtUsdc(100), price: load.fmtPrice(1),
                validUtil: load.expireAfter(1, 'day')
            }
        }, {
            run: async () => {
                const nextTimestamp = await load.expireAfter(2, 'day');
                if (hre.network.zksync) {
                    await getZkTestProvider()
                        .send("evm_setNextBlockTimestamp", [nextTimestamp]);
                } else {
                    await time.increaseTo(nextTimestamp);
                }

                // order1 should be expired now
            }
        }, {
            submitOrder: {
                owner: load.alice, side: OrderSide.SELL,
                amount: load.fmtWeth(100), price: load.fmtPrice(1),
                orderAliasesToFill: ['order1'],
                expectNoFill: true,
                expectClosed: [
                    {alias: 'order1', executeAmt: 0, receiveAmt: 0, feeAmt: 0, reason: OrderCloseReason.EXPIRED}
                ]
            }
        }]);
    });
});
