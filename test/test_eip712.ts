import {OrderSide, setUpTest, TimeInForce} from "./utils";
import {ethers, Signer} from "ethers";
import hre from "hardhat";
import {expect} from "chai";
import {anyValue} from "@nomicfoundation/hardhat-chai-matchers/withArgs";

describe("OrderBook - Blackbox testing EIP712 features", async () => {
    it("Test submit order on behalf of user", async () => {
        const load = await setUpTest();
        const price = load.fmtPrice(1);
        const amount = load.fmtUsdc(10);
        const side = OrderSide.BUY;
        const validUntil = await load.expireAfter(7, 'days');
        const networkFee = load.fmtUsdc(1);
        const nonce = 1;
        const pairId = load.defaultPairId;
        const tif = TimeInForce.GTC;

        const signature = ethers.Signature.from(await (load.bob as Signer).signTypedData({
            name: "zkLite Order Book",
            version: "v1",
            chainId: hre.network.config.chainId,
            verifyingContract: await load.OrderBookContract.getAddress(),
        }, {
            "SubmitOrder": [
                {
                    "name": "side",
                    "type": "uint8"
                }, {
                    "name": "price",
                    "type": "uint256"
                }, {
                    "name": "amount",
                    "type": "uint256"
                }, {
                    "name": "pairId",
                    "type": "uint16"
                }, {
                    "name": "validUntil",
                    "type": "uint32"
                }, {
                    "name": "tif",
                    "type": "uint8"
                }, {
                    "name": "networkFee",
                    "type": "uint256"
                }, {
                    "name": "nonce",
                    "type": "uint256"
                }, {
                    "name": "orderIdsToCancel",
                    "type": "uint256[]"
                }, {
                    "name": "orderIdsToFill",
                    "type": "uint256[]"
                }
            ]
        }, {
            side: side,
            price: price,
            amount: amount,
            pairId: pairId,
            validUntil: validUntil,
            tif: tif,
            networkFee: networkFee,
            nonce: nonce,
            orderIdsToCancel: [],
            orderIdsToFill: []
        }));

        await load.USDC.connect(load.bob).approve(load.OrderBookContract, load.uintMax);

        // alice submit order on behalf of bob
        await expect(
            load.OrderBookContract.connect(load.alice)
                .submitOrderOnBehalfOf(
                    load.bob.address,
                    side, price, amount, pairId, validUntil,
                    tif, networkFee, nonce, [], [],
                    signature.v, signature.r, signature.s
                )
        ).to.emit(load.OrderBookContract, "NewOrderEvent")
            .withArgs(anyValue, load.bob.address, price, amount, pairId, side, validUntil);

        // submit again should be fail, nonce is used
        await expect(
            load.OrderBookContract.connect(load.alice)
                .submitOrderOnBehalfOf(
                    load.bob.address,
                    side, price, amount, pairId, validUntil,
                    tif, networkFee, nonce, [], [],
                    signature.v, signature.r, signature.s
                )
        ).to.be.revertedWith("Nonce is used");
    });
});
